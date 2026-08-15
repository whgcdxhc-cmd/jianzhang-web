export interface CloudBindings {
  DB?: D1Database;
  FILES?: R2Bucket;
}

type CloudUser = {
  userId: string;
  email: string;
  displayName: string;
};

type CloudStateRow = {
  state_json: string;
  revision: number;
  updated_at: string;
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const MAX_REQUEST_BYTES = 18 * 1024 * 1024;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const DATA_IMAGE = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i;

export async function handleCloudApi(
  request: Request,
  env: CloudBindings,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/cloud/")) return null;

  try {
    const user = authenticatedUser(request);
    if (!user) {
      return json(
        { error: "请先登录简账云端账号", code: "AUTH_REQUIRED" },
        401,
      );
    }

    if (request.method !== "GET" && !isSameOriginRequest(request)) {
      return json({ error: "请求来源无效", code: "INVALID_ORIGIN" }, 403);
    }

    if (url.pathname === "/api/cloud/account" && request.method === "GET") {
      const row = await readState(env, user.userId);
      return json({
        account: { email: user.email, displayName: user.displayName },
        state: row ? JSON.parse(row.state_json) : null,
        revision: row?.revision ?? 0,
        updatedAt: row?.updated_at ?? null,
        storage: "cloud",
      });
    }

    if (url.pathname === "/api/cloud/state" && request.method === "PUT") {
      const payload = await readJsonPayload(request);
      const state = unwrapState(payload);
      const baseRevision = finiteInteger(payload.baseRevision, 0);
      const saved = await saveState(env, user, state, baseRevision);
      return json(saved);
    }

    if (url.pathname === "/api/cloud/import" && request.method === "POST") {
      const payload = await readJsonPayload(request);
      const state = unwrapState(payload);
      const row = await readState(env, user.userId);
      const saved = await saveState(env, user, state, row?.revision ?? 0);
      return json({ ...saved, imported: true });
    }

    if (url.pathname === "/api/cloud/export" && request.method === "GET") {
      const row = await readState(env, user.userId);
      const storedState = row ? JSON.parse(row.state_json) : null;
      const state = storedState
        ? await hydrateStateImages(storedState, user.userId, env)
        : null;
      const body = JSON.stringify(
        {
          format: "jianzhang-cloud-backup",
          schemaVersion: 1,
          exportedAt: new Date().toISOString(),
          account: { email: user.email },
          state,
        },
        null,
        2,
      );
      return new Response(body, {
        headers: {
          ...JSON_HEADERS,
          "content-disposition": `attachment; filename="jianzhang-cloud-backup.json"`,
        },
      });
    }

    if (url.pathname === "/api/cloud/file" && request.method === "GET") {
      return servePrivateFile(url, user, env);
    }

    return json({ error: "接口不存在", code: "NOT_FOUND" }, 404);
  } catch (error) {
    console.error("Cloud API error", error);
    if (error instanceof CloudApiError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    return json(
      { error: "云端服务暂时不可用，请稍后重试", code: "CLOUD_ERROR" },
      500,
    );
  }
}

function authenticatedUser(request: Request): CloudUser | null {
  const userId = request.headers.get("oai-authenticated-user-id")?.trim();
  const email = request.headers.get("oai-authenticated-user-email")?.trim();
  if (!userId || !email) return null;

  const encodedName = request.headers.get("oai-authenticated-user-full-name");
  const encoding = request.headers.get(
    "oai-authenticated-user-full-name-encoding",
  );
  let displayName = email;
  if (encodedName && encoding === "percent-encoded-utf-8") {
    try {
      displayName = decodeURIComponent(encodedName);
    } catch {
      displayName = email;
    }
  }
  return { userId, email, displayName };
}

function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

async function readState(
  env: CloudBindings,
  userId: string,
): Promise<CloudStateRow | null> {
  const db = requireDatabase(env);
  return db
    .prepare(
      "SELECT state_json, revision, updated_at FROM cloud_states WHERE user_id = ? LIMIT 1",
    )
    .bind(userId)
    .first<CloudStateRow>();
}

async function saveState(
  env: CloudBindings,
  user: CloudUser,
  rawState: unknown,
  baseRevision: number,
) {
  assertState(rawState);
  const db = requireDatabase(env);
  const state = await externalizeStateImages(rawState, user.userId, env);
  const stateJson = JSON.stringify(state);
  if (new TextEncoder().encode(stateJson).byteLength > MAX_STATE_BYTES) {
    throw new CloudApiError(413, "STATE_TOO_LARGE", "云端账本数据过大，请先导出并精简图片");
  }

  const now = new Date().toISOString();
  const current = await readState(env, user.userId);
  if ((current?.revision ?? 0) !== baseRevision) {
    throw new CloudApiError(
      409,
      "REVISION_CONFLICT",
      "另一台设备刚刚更新了账本，请刷新后重试",
    );
  }

  if (current) {
    const result = await db
      .prepare(
        "UPDATE cloud_states SET email = ?, state_json = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?",
      )
      .bind(user.email, stateJson, now, user.userId, baseRevision)
      .run();
    if ((result.meta?.changes ?? 0) !== 1) {
      throw new CloudApiError(
        409,
        "REVISION_CONFLICT",
        "另一台设备刚刚更新了账本，请刷新后重试",
      );
    }
  } else {
    const result = await db
      .prepare(
        "INSERT OR IGNORE INTO cloud_states (user_id, email, state_json, revision, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
      )
      .bind(user.userId, user.email, stateJson, now, now)
      .run();
    if ((result.meta?.changes ?? 0) !== 1) {
      throw new CloudApiError(
        409,
        "REVISION_CONFLICT",
        "云端账号已在其他设备初始化，请刷新后重试",
      );
    }
  }

  return {
    state,
    revision: baseRevision + 1,
    updatedAt: now,
    storage: "cloud",
  };
}

async function externalizeStateImages(
  rawState: unknown,
  userId: string,
  env: CloudBindings,
) {
  const state = structuredClone(rawState) as Record<string, unknown>;
  const records = Array.isArray(state.records) ? state.records : [];
  for (const item of records) {
    if (!isObject(item) || !Array.isArray(item.images)) continue;
    item.images = await Promise.all(
      item.images.map((value) => externalizeImage(value, userId, env)),
    );
  }

  if (isObject(state.dayBackgrounds)) {
    for (const [date, value] of Object.entries(state.dayBackgrounds)) {
      state.dayBackgrounds[date] = await externalizeImage(value, userId, env);
    }
  }
  return state;
}

async function hydrateStateImages(
  rawState: unknown,
  userId: string,
  env: CloudBindings,
) {
  const state = structuredClone(rawState) as Record<string, unknown>;
  const records = Array.isArray(state.records) ? state.records : [];
  for (const item of records) {
    if (!isObject(item) || !Array.isArray(item.images)) continue;
    item.images = await Promise.all(
      item.images.map((value) => hydrateImage(value, userId, env)),
    );
  }
  if (isObject(state.dayBackgrounds)) {
    for (const [date, value] of Object.entries(state.dayBackgrounds)) {
      state.dayBackgrounds[date] = await hydrateImage(value, userId, env);
    }
  }
  return state;
}

async function externalizeImage(
  value: unknown,
  userId: string,
  env: CloudBindings,
): Promise<unknown> {
  if (typeof value !== "string") return value;
  const match = DATA_IMAGE.exec(value);
  if (!match) return value;

  const bytes = decodeBase64(match[2]);
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new CloudApiError(413, "IMAGE_TOO_LARGE", "单张图片不能超过 6MB");
  }
  const files = requireFiles(env);
  const scope = await userScope(userId);
  const hash = await sha256Hex(bytes);
  const extension = imageExtension(match[1].toLowerCase());
  const key = `${scope}/media/${hash}.${extension}`;
  if (!(await files.head(key))) {
    await files.put(key, bytes, {
      httpMetadata: { contentType: match[1].toLowerCase() },
      customMetadata: { owner: scope },
    });
  }
  return `/api/cloud/file?key=${encodeURIComponent(key)}`;
}

async function hydrateImage(
  value: unknown,
  userId: string,
  env: CloudBindings,
): Promise<unknown> {
  if (typeof value !== "string") return value;
  const key = cloudFileKey(value);
  if (!key) return value;
  const scope = await userScope(userId);
  if (!key.startsWith(`${scope}/`)) return value;

  const object = await requireFiles(env).get(key);
  if (!object) return value;
  const bytes = new Uint8Array(await object.arrayBuffer());
  const contentType = object.httpMetadata?.contentType || "image/jpeg";
  return `data:${contentType};base64,${encodeBase64(bytes)}`;
}

async function servePrivateFile(
  url: URL,
  user: CloudUser,
  env: CloudBindings,
): Promise<Response> {
  const key = url.searchParams.get("key") || "";
  const scope = await userScope(user.userId);
  if (!key.startsWith(`${scope}/`)) {
    return json({ error: "文件不存在", code: "FILE_NOT_FOUND" }, 404);
  }
  const object = await requireFiles(env).get(key);
  if (!object) {
    return json({ error: "文件不存在", code: "FILE_NOT_FOUND" }, 404);
  }
  const headers = new Headers({
    "cache-control": "private, no-store",
    "content-type": object.httpMetadata?.contentType || "application/octet-stream",
    "x-content-type-options": "nosniff",
  });
  return new Response(object.body, { headers });
}

async function readJsonPayload(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    throw new CloudApiError(413, "REQUEST_TOO_LARGE", "导入文件或图片数据过大");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new CloudApiError(413, "REQUEST_TOO_LARGE", "导入文件或图片数据过大");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new CloudApiError(400, "INVALID_JSON", "JSON 文件格式无效");
  }
  if (!isObject(payload)) {
    throw new CloudApiError(400, "INVALID_JSON", "请求内容必须是 JSON 对象");
  }
  return payload;
}

function unwrapState(payload: Record<string, unknown>): unknown {
  if (isObject(payload.state)) return payload.state;
  if (isObject(payload.data)) return payload.data;
  if (Array.isArray(payload.records) || Array.isArray(payload.ledgers)) return payload;
  throw new CloudApiError(400, "INVALID_STATE", "没有找到可导入的简账数据");
}

function assertState(value: unknown): asserts value is Record<string, unknown> {
  if (!isObject(value)) {
    throw new CloudApiError(400, "INVALID_STATE", "账本数据格式无效");
  }
  if (value.records !== undefined && !Array.isArray(value.records)) {
    throw new CloudApiError(400, "INVALID_STATE", "账单列表格式无效");
  }
  if (value.ledgers !== undefined && !Array.isArray(value.ledgers)) {
    throw new CloudApiError(400, "INVALID_STATE", "账本列表格式无效");
  }
}

function cloudFileKey(value: string): string | null {
  try {
    const url = new URL(value, "https://jianzhang.local");
    if (url.pathname !== "/api/cloud/file") return null;
    return url.searchParams.get("key");
  } catch {
    return null;
  }
}

function requireDatabase(env: CloudBindings): D1Database {
  if (!env.DB) {
    throw new CloudApiError(503, "DATABASE_UNAVAILABLE", "云数据库尚未完成配置");
  }
  return env.DB;
}

function requireFiles(env: CloudBindings): R2Bucket {
  if (!env.FILES) {
    throw new CloudApiError(503, "FILES_UNAVAILABLE", "云端图片存储尚未完成配置");
  }
  return env.FILES;
}

function imageExtension(contentType: string): string {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/gif") return "gif";
  return "jpg";
}

function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value.replace(/\s/g, ""));
  } catch {
    throw new CloudApiError(400, "INVALID_IMAGE", "图片编码无效");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function userScope(userId: string): Promise<string> {
  return (await sha256Hex(new TextEncoder().encode(userId))).slice(0, 32);
}

async function sha256Hex(value: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function finiteInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

class CloudApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
