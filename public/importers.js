import { parseBookkeepingText } from "./parser.js";

const MAX_IMPORT_BYTES = 30 * 1024 * 1024;

export async function parseWechatExcel(file, context = {}) {
  assertFile(file, [".xlsx"]);
  const entries = await unzipEntries(await file.arrayBuffer());
  const sharedStrings = entries.has("xl/sharedStrings.xml")
    ? parseSharedStrings(await entryText(entries, "xl/sharedStrings.xml"))
    : [];
  const worksheetName = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort()[0];
  if (!worksheetName) throw new Error("没有在微信 Excel 中找到交易明细工作表");
  const rows = parseWorksheet(await entryText(entries, worksheetName), sharedStrings);
  return normalizeRows(rows, "wechat", context);
}

export async function parseAlipayCsv(file, context = {}) {
  assertFile(file, [".csv"]);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  let text = utf8;
  if (!/支付宝|交易时间/.test(utf8)) {
    try {
      text = new TextDecoder("gb18030").decode(bytes);
    } catch {
      text = utf8;
    }
  }
  return normalizeRows(parseCsv(text.replace(/^\uFEFF/, "")), "alipay", context);
}

function normalizeRows(rows, provider, context) {
  const headerNames = provider === "wechat"
    ? ["交易时间", "交易类型", "交易对方", "商品", "收/支", "金额(元)", "支付方式", "当前状态", "交易单号", "商户单号", "备注"]
    : ["交易时间", "交易分类", "交易对方", "对方账号", "商品说明", "收/支", "金额", "收/付款方式", "交易状态", "交易订单号", "商家订单号", "备注"];
  const headerIndex = rows.findIndex((row) => headerNames.every((name) => row.includes(name)));
  if (headerIndex < 0) {
    throw new Error(provider === "wechat" ? "无法识别微信账单表头" : "无法识别支付宝账单表头");
  }
  const headers = rows[headerIndex].map((value) => clean(value));
  const records = [];
  let skipped = 0;
  let excluded = 0;

  for (const row of rows.slice(headerIndex + 1)) {
    const item = Object.fromEntries(headers.map((header, index) => [header, clean(row[index])]));
    const amount = Number(String(item[provider === "wechat" ? "金额(元)" : "金额"] || "").replace(/[¥￥,\s]/g, ""));
    const dateTime = normalizeDateTime(item["交易时间"]);
    if (!dateTime || !Number.isFinite(amount) || amount <= 0) {
      skipped += 1;
      continue;
    }
    const direction = item["收/支"];
    const status = item[provider === "wechat" ? "当前状态" : "交易状态"];
    if (/交易关闭|已关闭/.test(status)) {
      skipped += 1;
      continue;
    }
    const type = direction === "收入" ? "income" : "expense";
    const isExcluded = !["收入", "支出"].includes(direction) || /全额退款|已退款/.test(status);
    if (isExcluded) excluded += 1;
    const merchant = item["交易对方"] || "未知交易对方";
    const product = item[provider === "wechat" ? "商品" : "商品说明"];
    const providerName = provider === "wechat" ? "微信支付" : "支付宝";
    const composed = [
      providerName,
      merchant,
      product,
      item[provider === "wechat" ? "交易类型" : "交易分类"],
      direction,
      `¥${amount}`,
      dateTime,
    ].filter(Boolean).join("\n");
    const parsed = parseBookkeepingText({
      text: composed,
      categories: context.categories || {},
      knownTags: context.knownTags || [],
      defaultLedgerId: context.ledgerId || "life",
      source: providerName + "账单导入",
    });
    const mappedCategory = provider === "alipay"
      ? mapAlipayCategory(item["交易分类"], type, context.categories)
      : null;
    const externalId = clean(item[provider === "wechat" ? "交易单号" : "交易订单号"]).replace(/\t/g, "");
    const merchantOrderId = clean(item[provider === "wechat" ? "商户单号" : "商家订单号"]).replace(/\t/g, "");
    const [date, time = "00:00:00"] = dateTime.split(" ");
    const noteParts = [
      merchant,
      validDetail(product, merchant),
      providerName,
      validDetail(item["备注"]),
    ].filter(Boolean);
    const timestamp = new Date(`${date}T${time}`).getTime();
    records.push({
      ...parsed,
      id: `import_${provider}_${stableHash(externalId || `${dateTime}|${merchant}|${amount}`)}`,
      ledgerId: context.ledgerId || parsed.ledgerId || "life",
      type,
      amount,
      date,
      time: time.length === 5 ? `${time}:00` : time,
      primaryId: mappedCategory?.primaryId || parsed.primaryId,
      secondary: mappedCategory?.secondary || parsed.secondary,
      note: noteParts.join(" · "),
      exclude: isExcluded,
      merchant,
      paymentMethod: item[provider === "wechat" ? "支付方式" : "收/付款方式"],
      transactionStatus: status,
      provider,
      externalId,
      merchantOrderId,
      source: providerName + "账单导入",
      captureRaw: "",
      autoRecognized: false,
      amountMissing: false,
      createdAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
      updatedAt: Date.now(),
    });
  }

  return {
    provider,
    records,
    skipped,
    excluded,
    totalRows: Math.max(0, rows.length - headerIndex - 1),
  };
}

function mapAlipayCategory(label, type, categories = {}) {
  if (type === "income") return null;
  const rules = [
    [/餐饮|美食|外卖/, "餐饮"],
    [/交通|出行|打车|火车|机票/, "交通"],
    [/日用|百货|购物|服饰|数码|家居/, "购物"],
    [/医疗|健康|药品/, "医疗"],
    [/酒店|旅游|旅行/, "旅行"],
    [/教育|学习|书籍/, "学习"],
    [/文化|休闲|娱乐|游戏/, "娱乐"],
    [/话费|通讯|网络/, "话费网费"],
  ];
  const target = rules.find(([pattern]) => pattern.test(label || ""));
  if (!target) return null;
  const category = (categories.expense || []).find((item) => item.name === target[1]);
  return category ? { primaryId: category.id, secondary: "" } : null;
}

function validDetail(value, duplicate = "") {
  const text = clean(value);
  return !text || text === "/" || text === duplicate ? "" : text;
}

function normalizeDateTime(value) {
  if (typeof value === "number" || /^\d{5}(?:\.\d+)?$/.test(String(value || ""))) {
    const serial = Number(value);
    const date = new Date(Math.round((serial - 25569) * 86400000));
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  }
  const match = String(value || "").match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\s+(\d{1,2}):([0-5]\d)(?::([0-5]\d))?/);
  return match ? `${match[1]}-${pad(match[2])}-${pad(match[3])} ${pad(match[4])}:${match[5]}:${match[6] || "00"}` : "";
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

async function unzipEntries(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error("Excel 文件结构无效");
  const entries = new Map();
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder("utf-8");
  for (let entryIndex = 0; entryIndex < count; entryIndex += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Excel ZIP 目录无效");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, { method, bytes: bytes.slice(dataStart, dataStart + compressedSize) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function entryText(entries, name) {
  const entry = entries.get(name);
  if (!entry) throw new Error(`Excel 缺少 ${name}`);
  let bytes = entry.bytes;
  if (entry.method === 8) {
    if (!("DecompressionStream" in globalThis)) throw new Error("当前浏览器不支持微信 Excel 解压，请升级 Chrome");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else if (entry.method !== 0) throw new Error("微信 Excel 使用了暂不支持的压缩格式");
  return new TextDecoder("utf-8").decode(bytes);
}

function parseSharedStrings(xml) {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((item) =>
    [...item[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((text) => decodeXmlText(text[1])).join(""),
  );
}

function parseWorksheet(xml, sharedStrings) {
  return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)].map((row) => {
    const values = [];
    for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const reference = attribute(cell[1], "r") || "A1";
      const column = columnIndex(reference.replace(/\d/g, ""));
      const type = attribute(cell[1], "t") || "";
      const raw = decodeXmlText(cell[2].match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] || "");
      if (type === "s") values[column] = sharedStrings[Number(raw)] || "";
      else if (type === "inlineStr") values[column] = [...cell[2].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((item) => decodeXmlText(item[1])).join("");
      else values[column] = raw === "" ? "" : Number.isFinite(Number(raw)) ? Number(raw) : raw;
    }
    return values;
  });
}

function attribute(source, name) {
  return decodeXmlText(source.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"))?.[1] || "");
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)));
}

function columnIndex(letters) {
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.toUpperCase().charCodeAt(0) - 64;
  return Math.max(0, value - 1);
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
}

function assertFile(file, extensions) {
  if (!file || file.size > MAX_IMPORT_BYTES) throw new Error("账单文件不能超过 30MB");
  if (!extensions.some((extension) => file.name.toLowerCase().endsWith(extension))) throw new Error(`请选择 ${extensions.join(" / ")} 文件`);
}

function clean(value) { return String(value ?? "").trim(); }
function pad(value) { return String(value).padStart(2, "0"); }
