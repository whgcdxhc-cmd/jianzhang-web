const pad=value=>String(value).padStart(2,"0");
const localDate=date=>`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
const localTime=date=>`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
const CATEGORY_RULES=[
  [/咖啡|瑞幸|星巴克|拿铁|美式|卡布奇诺/,"餐饮","咖啡"],
  [/早餐|豆浆|包子|油条|早餐店/,"餐饮","早餐"],
  [/午餐|午饭|工作餐/,"餐饮","午餐"],
  [/晚餐|晚饭|火锅|海底捞/,"餐饮","晚餐"],
  [/夜宵|宵夜/,"餐饮","夜宵"],
  [/餐厅|饭店|食堂|外卖|美团|饿了么|麦当劳|肯德基|奶茶|饮品/,"餐饮",null],
  [/滴滴|高德打车|出租车|网约车|打车/,"交通","打车"],[/地铁/,"交通","地铁"],[/公交/,"交通","公交"],
  [/12306|铁路|高铁|动车|火车票/,"交通","高铁"],[/酒店|宾馆|民宿|住宿|携程|去哪儿/,"旅行","住宿"],
  [/门票|景区/,"旅行","门票"],[/医院|门诊|诊所|药房|药店|买药/,"医疗",null],
  [/话费|中国移动|中国电信|中国联通|宽带|流量/,"话费网费",null],
  [/淘宝|京东|拼多多|天猫|商场|超市|盒马|山姆|购物/,"购物",null],[/快递|运费|跑腿/,"运费",null]
];
const MONEY_PATTERNS=[
  /(?:支付金额|付款金额|实付款|实付|交易金额|订单金额|收款金额|到账金额|退款金额|红包金额)\s*[:：]?\s*[¥￥]?\s*(-?\d[\d,]*(?:\.\d{1,2})?)/i,
  /[¥￥]\s*(-?\d[\d,]*(?:\.\d{1,2})?)/,
  /(?:支付|付款|消费|收款|到账|退款|转账|红包)[^\d-]{0,12}(-?\d[\d,]*(?:\.\d{1,2})?)\s*(?:元|块|块钱)?/i
];
const CHINESE_DIGITS={零:0,"〇":0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
const CHINESE_UNITS={十:10,百:100,千:1000,万:10000,亿:100000000};
function chineseInteger(value){
  let total=0,section=0,number=0;
  for(const char of value){
    if(char in CHINESE_DIGITS){number=CHINESE_DIGITS[char];continue}
    const unit=CHINESE_UNITS[char];if(!unit)continue;
    if(unit<10000){section+=(number||1)*unit}else{section=(section+number)*unit;total+=section;section=0}number=0;
  }
  return total+section+number;
}
function chineseNumber(value){
  value=String(value||"").trim();if(/^\d+(?:\.\d+)?$/.test(value))return Number(value);
  const [integerPart,decimalPart]=value.split("点"),integer=chineseInteger(integerPart),decimal=decimalPart?[...decimalPart].map(char=>CHINESE_DIGITS[char]).filter(x=>x!==undefined).join(""):"";
  return decimal?integer+Number(`0.${decimal}`):integer;
}
function extractChineseAmount(text){
  const match=text.match(/([零〇一二两三四五六七八九十百千万亿点]+)\s*(?:元|块钱|块)(?:\s*([零〇一二两三四五六七八九\d])\s*(?:角|毛))?(?:\s*([零〇一二两三四五六七八九\d])\s*分)?/);
  if(match){const base=chineseNumber(match[1]),jiao=match[2]?chineseNumber(match[2])/10:0,fen=match[3]?chineseNumber(match[3])/100:0,value=base+jiao+fen;if(value>0&&value<10000000)return value}
  const cents=text.match(/([零〇一二两三四五六七八九])\s*(?:角|毛)(?:\s*([零〇一二两三四五六七八九])\s*分)?/);if(cents)return chineseNumber(cents[1])/10+(cents[2]?chineseNumber(cents[2])/100:0);
  return 0;
}
function extractAmount(text){for(const pattern of MONEY_PATTERNS){const match=text.match(pattern),value=match&&Number(match[1].replace(/,/g,""));if(Number.isFinite(value)&&Math.abs(value)>0&&Math.abs(value)<10000000)return Math.abs(value)}return extractChineseAmount(text)}
function extractDateTime(text,now){
  let date=localDate(now),time=localTime(now),match=text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/);
  if(match)date=`${match[1]}-${pad(match[2])}-${pad(match[3])}`;else if(/大前天/.test(text)){const d=new Date(now);d.setDate(d.getDate()-3);date=localDate(d)}else if(/前天/.test(text)){const d=new Date(now);d.setDate(d.getDate()-2);date=localDate(d)}else if(/昨天/.test(text)){const d=new Date(now);d.setDate(d.getDate()-1);date=localDate(d)}
  match=text.match(/(?:^|\D)([01]?\d|2[0-3])[:：]([0-5]\d)(?:[:：]([0-5]\d))?(?!\d)/);if(match)time=`${pad(match[1])}:${match[2]}:${match[3]||"00"}`;return {date,time}
}
function paymentSource(text){if(/支付宝|花呗|余额宝/.test(text))return "支付宝";if(/微信|零钱通|零钱/.test(text))return "微信支付";if(/云闪付/.test(text))return "云闪付";return ""}
function extractMerchant(text){const lines=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean),labels=/^(微信支付|支付宝|云闪付|支付成功|付款成功|交易成功|收款成功|退款成功|转账成功|订单详情|账单详情|完成|返回)$/,metadata=/(?:支付|付款|交易|订单|收款|到账|退款)?(?:金额|时间|方式|单号)|余额|银行卡|零钱|花呗|信用卡|¥|￥|\d{4}[-/.年]\d{1,2}|^\d{1,2}[:：]\d{2}/;return lines.find(line=>line.length>=2&&line.length<=40&&!labels.test(line)&&!metadata.test(line)&&!/^[-+]?\d+(?:\.\d+)?元?$/.test(line))||""}
function detectType(text){const expense=/支付成功|付款成功|已支付|消费|支出|付款给|你已转账|发出红包|转出/,income=/收款成功|已收款|到账|收入|收到|工资|薪资|退款成功|已退款|退回|转给我|向你转账|收到红包|红包收入/;return income.test(text)&&!expense.test(text)?"income":"expense"}
function findCategory(categories,type,name){const list=categories?.[type]||[];return list.find(item=>item.name===name)||list.find(item=>item.name.includes(name)||name.includes(item.name))}
function classify(text,type,time,categories){
  if(type==="income"){const target=/退款|退回/.test(text)?["退款/报销","退款"]:/工资|薪资/.test(text)?["工资",null]:/红包/.test(text)?["人情","红包"]:/转账|收款/.test(text)?["人情","转账"]:["其他",null],category=findCategory(categories,type,target[0])||(categories?.income||[]).find(item=>item.id==="other-i")||(categories?.income||[])[0];return {primaryId:category?.id||"",secondary:category?.children?.includes(target[1])?target[1]:""}}
  let target=CATEGORY_RULES.find(([pattern])=>pattern.test(text));if(!target&&/餐|饭|食/.test(text)){const hour=Number(time.slice(0,2));target=[null,"餐饮",hour<10?"早餐":hour<15?"午餐":"晚餐"]}
  const category=findCategory(categories,type,target?.[1]||"其他")||(categories?.expense||[]).find(item=>item.id==="other-e")||(categories?.expense||[])[0];return {primaryId:category?.id||"",secondary:category?.children?.includes(target?.[2])?target[2]:""}
}
export function parseBookkeepingText(input={}){
  const text=String(input.text||"").replace(/\u00a0/g," ").trim(),now=input.now instanceof Date?input.now:new Date(),amount=extractAmount(text),type=detectType(text),{date,time}=extractDateTime(text,now),merchant=extractMerchant(text),sourceName=paymentSource(text),classification=classify(`${text} ${merchant}`,type,time,input.categories||{}),tags=[...new Set((input.knownTags||[]).filter(tag=>tag&&text.includes(tag)))],note=[merchant,sourceName].filter(Boolean).join(" · ")||"自动识屏记账";
  let confidence=text?35:5;if(amount)confidence+=35;if(merchant)confidence+=12;if(classification.primaryId&&!classification.primaryId.startsWith("other"))confidence+=12;if(/\d{1,2}[:：]\d{2}/.test(text))confidence+=4;
  return {type,amount,...classification,date,time,tags,note,exclude:false,location:null,images:[],mood:"",ledgerId:input.defaultLedgerId||"",source:input.source||"自动识屏",merchant,confidence:Math.min(98,confidence),captureRaw:text,captureSource:input.source||"自动识屏",autoRecognized:true,amountMissing:!amount}
}
