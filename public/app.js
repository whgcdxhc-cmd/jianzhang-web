import {loadState,saveState,exportCloudState,importCloudState,getCloudStatus,CloudStorageError} from "./storage.js";
import {parseBookkeepingText} from "./parser.js";
import {parseWechatExcel,parseAlipayCsv} from "./importers.js";

const $=id=>document.getElementById(id);
const $$=sel=>Array.from(document.querySelectorAll(sel));
const uid=p=>p+"_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,7);
const money=n=>"¥"+Number(n||0).toFixed(2);
const pad=n=>String(n).padStart(2,"0");
const today=(d=new Date())=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const nowTime=(d=new Date())=>`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const clone=o=>structuredClone?structuredClone(o):JSON.parse(JSON.stringify(o));
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

const ICONS={"餐饮":"🍴","交通":"🚌","购物":"🛍","旅行":"🌴","话费网费":"☎","学习":"📚","医疗":"⚕","娱乐":"🎬","人情":"🧧","居住":"🏠","运动":"🏃","运费":"📦","工资":"💼","兼职":"🧑‍💻","退款/报销":"↩","家庭":"🏡","其他":"◈","早餐":"🥣","午餐":"🍱","晚餐":"🍲","夜宵":"🌙","咖啡":"☕","零食":"🍪","地铁":"🚇","公交":"🚌","打车":"🚕","高铁":"🚄","住宿":"🏨","门票":"🎫","红包":"🧧","转账":"💸"};
const iconFor=n=>ICONS[n]||"◈";
const FONT_PRESETS={
  clean:'"MiSans","HarmonyOS Sans SC","PingFang SC","Microsoft YaHei",sans-serif',
  system:'-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
  rounded:'"SF Pro Rounded","Arial Rounded MT Bold","PingFang SC","Microsoft YaHei",sans-serif',
  serif:'"Songti SC","STSong","Noto Serif CJK SC","SimSun",serif'
};

const defaultState={
  version:"0.3.0",
  currentLedgerId:"life",
  ledgers:[{id:"life",name:"生活账本"},{id:"travel",name:"旅游账本"}],
  categories:{
    expense:[
      {id:"food",name:"餐饮",children:["早餐","午餐","晚餐","夜宵","咖啡","零食"]},
      {id:"transport",name:"交通",children:["地铁","公交","打车","高铁"]},
      {id:"shopping",name:"购物",children:["衣服","日用品","美妆","护肤","电器数码"]},
      {id:"travel-e",name:"旅行",children:["住宿","门票","当地交通","伴手礼"]},
      {id:"network",name:"话费网费",children:["手机话费","宽带","流量"]},
      {id:"study",name:"学习",children:["图书","打印","课程","考试"]},
      {id:"medical",name:"医疗",children:["买药","门诊","检查"]},
      {id:"entertain",name:"娱乐",children:["电影","游戏","聚会"]},
      {id:"gift-e",name:"人情",children:["发红包","礼物","请客"]},
      {id:"home",name:"居住",children:["房租","水费","电费","水电煤"]},
      {id:"sport",name:"运动",children:["场地","装备","课程"]},
      {id:"shipping",name:"运费",children:["快递","跑腿"]},
      {id:"other-e",name:"其他",children:[]}
    ],
    income:[
      {id:"salary",name:"工资",children:["基本工资","奖金","补贴"]},
      {id:"parttime",name:"兼职",children:["运营","咨询","家教"]},
      {id:"gift-i",name:"人情",children:["红包","转账","礼金"]},
      {id:"refund-i",name:"退款/报销",children:["退款","报销"]},
      {id:"family",name:"家庭",children:["生活费","家人转账"]},
      {id:"other-i",name:"其他",children:[]}
    ]
  },
  records:[],templates:[],dayMeta:{},dayBackgrounds:{},settings:{fontPreset:"clean",customFont:""}
};

let state=clone(defaultState);
let rec={type:"expense",amount:"0.00",primaryId:"food",secondary:"",date:today(),time:nowTime(),tags:[],note:"",exclude:false,location:null,images:[],mood:""};
let editingId=null,currentCoords=null,categoryManageType="expense",swipeOpen=null,aiCandidate=null,currentAutoCapture=null;

function normalize(s){
  const x={...clone(defaultState),...(s||{})};
  x.ledgers=Array.isArray(x.ledgers)&&x.ledgers.length?x.ledgers:clone(defaultState.ledgers);
  x.categories=x.categories||clone(defaultState.categories);
  x.records=Array.isArray(x.records)?x.records:[];
  x.templates=Array.isArray(x.templates)?x.templates:[];
  x.dayMeta=x.dayMeta||{};x.dayBackgrounds=x.dayBackgrounds||{};
  x.settings={...defaultState.settings,...(x.settings||{})};
  x.records=x.records.map(r=>({...r,id:r.id||uid("r"),tags:Array.isArray(r.tags)?r.tags:[],images:Array.isArray(r.images)?r.images:[],location:r.location||null,mood:r.mood||"",exclude:!!(r.exclude??(r.type==="income"?r.excludeIncome:r.excludeExpense)),time:(r.time||"12:00:00").length===5?r.time+":00":r.time||"12:00:00"}));
  return x;
}
async function persist(){
  document.body.dataset.sync="syncing";
  try{
    state=normalize(await saveState(state));
    document.body.dataset.sync="saved";
    renderAll();
    return true
  }catch(err){
    console.error(err);
    document.body.dataset.sync="error";
    if(err?.code==="REVISION_CONFLICT"){
      try{state=normalize(await loadState());renderAll()}catch(loadErr){console.error(loadErr)}
    }
    showToast(err?.message||"未保存到云端，请检查网络");
    return false
  }
}
function currentLedger(){return state.ledgers.find(x=>x.id===state.currentLedgerId)||state.ledgers[0]}
function applyFont(){
  const preset=FONT_PRESETS[state.settings?.fontPreset]||FONT_PRESETS.clean;
  const custom=String(state.settings?.customFont||"").replace(/[;{}]/g,"").trim();
  const family=state.settings?.fontPreset==="custom"&&custom?`"${custom.replace(/["']/g,"")}",${FONT_PRESETS.system}`:preset;
  document.documentElement.style.setProperty("--app-font",family);
  if($("fontPreset")){$("fontPreset").value=state.settings?.fontPreset||"clean";$("customFont").value=state.settings?.customFont||"";$("customFontRow").classList.toggle("hidden",$("fontPreset").value!=="custom")}
}
function cat(type,id){return (state.categories[type]||[]).find(x=>x.id===id)}
function categoryText(r){const c=cat(r.type,r.primaryId);return (c?.name||"未分类")+(r.secondary?" · "+r.secondary:"")}
function parseDT(r){return new Date(`${r.date}T${r.time||"12:00:00"}`)}
function counted(r){return !r.exclude}
function sum(rs,type){return rs.filter(r=>r.type===type&&counted(r)).reduce((a,b)=>a+Number(b.amount||0),0)}
function showToast(t){$("toast").textContent=t;$("toast").classList.remove("hidden");clearTimeout(showToast.t);showToast.t=setTimeout(()=>$("toast").classList.add("hidden"),1800)}
function openSheet(id){$("backdrop").classList.remove("hidden");$(id).classList.remove("hidden")}
function closeSheet(id){$(id).classList.add("hidden");if(!$$(".sheet:not(.hidden)").length)$("backdrop").classList.add("hidden")}
function closeAll(){$$(".sheet").forEach(x=>x.classList.add("hidden"));$("backdrop").classList.add("hidden")}
function navigate(name){$$(".page").forEach(p=>p.classList.remove("active"));$(`page-${name}`).classList.add("active");$$(".bottom-nav [data-nav]").forEach(b=>b.classList.toggle("active",b.dataset.nav===name));if(name==="week")renderWeek();window.scrollTo(0,0)}
function range(period,anchor=new Date()){
  const d=new Date(anchor.getFullYear(),anchor.getMonth(),anchor.getDate()),s=new Date(d),e=new Date(d);
  if(period==="day"){}
  else if(period==="week"){const k=(d.getDay()+6)%7;s.setDate(d.getDate()-k);e.setTime(s.getTime());e.setDate(s.getDate()+6)}
  else if(period==="month"){s.setDate(1);e.setFullYear(d.getFullYear(),d.getMonth()+1,0)}
  else if(period==="quarter"){const q=Math.floor(d.getMonth()/3)*3;s.setFullYear(d.getFullYear(),q,1);e.setFullYear(d.getFullYear(),q+3,0)}
  else{s.setFullYear(d.getFullYear(),0,1);e.setFullYear(d.getFullYear(),11,31)}
  s.setHours(0,0,0,0);e.setHours(23,59,59,999);return {s,e}
}
function recordsIn(period,anchor,ledger=true){const {s,e}=range(period,anchor);return state.records.filter(r=>{const d=parseDT(r);return d>=s&&d<=e&&(!ledger||r.ledgerId===state.currentLedgerId)})}
function allTags(){return [...new Set(state.records.flatMap(r=>r.tags||[]))].sort((a,b)=>a.localeCompare(b,"zh-CN"))}

function recordHTML(r){
  const thumb=r.images?.[0]?`<img class="thumb" src="${r.images[0]}">`:"";
  const tags=(r.tags||[]).map(t=>`<span class="tag">#${esc(t)}</span>`).join("");
  const extras=[r.mood,r.location?.name?`⌖ ${r.location.name}`:"",r.images?.length?`▧ ${r.images.length}图`:"",r.exclude?"不计统计":""].filter(Boolean).map(x=>`<span class="tag">${esc(x)}</span>`).join("");
  return `<div class="record-wrap"><div class="record-actions"><button data-act="repeat" data-id="${r.id}">再记</button><button data-act="edit" data-id="${r.id}">修改</button><button data-act="refund" data-id="${r.id}">退款</button><button data-act="delete" data-id="${r.id}">删除</button></div><div class="record-item" data-record="${r.id}">${thumb}<div class="record-main"><div class="record-title">${esc(categoryText(r))}${tags}</div><div class="record-sub">${esc(r.date+" "+r.time)} · ${esc(state.ledgers.find(l=>l.id===r.ledgerId)?.name||"账本")}</div>${extras?`<div class="extra-line">${extras}</div>`:""}${r.note?`<div class="record-note">${esc(r.note)}</div>`:""}</div><div class="record-money ${r.type}">${r.type==="income"?"+":"-"}${money(r.amount)}</div></div></div>`
}
function attachSwipe(box){
  box.querySelectorAll(".record-item").forEach(item=>{
    let sx=0,dx=0,drag=false;
    item.addEventListener("pointerdown",e=>{sx=e.clientX;dx=0;drag=true});
    item.addEventListener("pointermove",e=>{if(!drag)return;dx=e.clientX-sx;if(dx<0)item.style.transform=`translateX(${Math.max(-244,dx)}px)`});
    item.addEventListener("pointerup",()=>{drag=false;if(dx<-50){if(swipeOpen&&swipeOpen!==item)swipeOpen.style.transform="";item.style.transform="translateX(-244px)";swipeOpen=item}else item.style.transform=""});
    item.addEventListener("click",()=>{if(Math.abs(dx)>8)return;openRecord(state.records.find(r=>r.id===item.dataset.record))})
  })
}
function renderRecordList(id,rs,limit){const list=[...rs].sort((a,b)=>parseDT(b)-parseDT(a));$(id).innerHTML=(limit?list.slice(0,limit):list).map(recordHTML).join("")||`<div class="semantic-result">还没有账单。</div>`;attachSwipe($(id))}
function renderHome(){const rs=recordsIn("month",new Date());const inc=sum(rs,"income"),exp=sum(rs,"expense");$("homeIncome").textContent=money(inc);$("homeExpense").textContent=money(exp);$("homeBalance").textContent=money(inc-exp);renderRecordList("recentList",state.records.filter(r=>r.ledgerId===state.currentLedgerId),6)}
function renderRecords(){
  const old=$("recordTagFilter").value;$("recordTagFilter").innerHTML=`<option value="all">全部标签</option>`+allTags().map(t=>`<option value="${esc(t)}">#${esc(t)}</option>`).join("");if([...$("recordTagFilter").options].some(o=>o.value===old))$("recordTagFilter").value=old;
  let rs=state.records.filter(r=>r.ledgerId===state.currentLedgerId);const type=$("recordTypeFilter").value,tag=$("recordTagFilter").value;if(type!=="all")rs=rs.filter(r=>r.type===type);if(tag!=="all")rs=rs.filter(r=>(r.tags||[]).includes(tag));renderRecordList("recordList",rs)
}

function buckets(period,anchor,rs){
  const R=range(period,anchor),out=[];
  if(period==="day"){for(let h=0;h<24;h+=4){const s=new Date(anchor.getFullYear(),anchor.getMonth(),anchor.getDate(),h),e=new Date(anchor.getFullYear(),anchor.getMonth(),anchor.getDate(),h+3,59,59);out.push({label:`${pad(h)}时`,s,e})}}
  else if(period==="week"){for(let i=0;i<7;i++){const s=new Date(R.s);s.setDate(s.getDate()+i);const e=new Date(s);e.setHours(23,59,59,999);out.push({label:"一二三四五六日"[i],s,e})}}
  else if(period==="month"){for(let d=1;d<=new Date(anchor.getFullYear(),anchor.getMonth()+1,0).getDate();d+=7){const s=new Date(anchor.getFullYear(),anchor.getMonth(),d),e=new Date(anchor.getFullYear(),anchor.getMonth(),Math.min(d+6,new Date(anchor.getFullYear(),anchor.getMonth()+1,0).getDate()),23,59,59);out.push({label:`${d}日`,s,e})}}
  else if(period==="quarter"){for(let m=R.s.getMonth();m<=R.e.getMonth();m++){out.push({label:`${m+1}月`,s:new Date(anchor.getFullYear(),m,1),e:new Date(anchor.getFullYear(),m+1,0,23,59,59)})}}
  else{for(let m=0;m<12;m++)out.push({label:`${m+1}月`,s:new Date(anchor.getFullYear(),m,1),e:new Date(anchor.getFullYear(),m+1,0,23,59,59)})}
  return out.map(b=>{const z=rs.filter(r=>{const d=parseDT(r);return d>=b.s&&d<=b.e});return {...b,income:sum(z,"income"),expense:sum(z,"expense")}})
}
function renderStats(){
  const anchor=new Date(($("statsDate").value||today())+"T12:00:00"),period=$("statsPeriod").value,rs=recordsIn(period,anchor),inc=sum(rs,"income"),exp=sum(rs,"expense");
  $("statsIncome").textContent=money(inc);$("statsExpense").textContent=money(exp);$("statsBalance").textContent=money(inc-exp);
  const total=inc+exp,p=total?inc/total*100:0;$("pieChart").innerHTML=total?`<div class="pie" style="background:conic-gradient(var(--income) 0 ${p}%,var(--expense) ${p}% 100%)"><div class="pie-center"><span>总收支</span><b>${money(total)}</b></div></div>`:`<div class="semantic-result">暂无数据</div>`;
  const bs=buckets(period,anchor,rs),max=Math.max(1,...bs.flatMap(b=>[b.income,b.expense]));$("barChart").innerHTML=bs.map(b=>`<div class="bar-group"><div class="vbar in" style="height:${b.income/max*180}px"></div><div class="vbar out" style="height:${b.expense/max*180}px"></div><div class="bar-label">${esc(b.label)}</div></div>`).join("");
  const rank={};rs.filter(r=>r.type==="expense"&&counted(r)).forEach(r=>{const n=cat(r.type,r.primaryId)?.name||"未分类";rank[n]=(rank[n]||0)+Number(r.amount)});const arr=Object.entries(rank).sort((a,b)=>b[1]-a[1]),mx=Math.max(1,...arr.map(x=>x[1]));$("categoryRank").innerHTML=arr.map(([n,v])=>`<div class="rank-row"><span>${esc(n)}</span><div class="rank-track"><div class="rank-fill" style="width:${v/mx*100}%"></div></div><b>${money(v)}</b></div>`).join("")||`<div class="semantic-result">暂无支出</div>`;
  renderReport(anchor)
}
function renderReport(anchor){const ds=today(anchor),rs=state.records.filter(r=>r.date===ds&&r.ledgerId===state.currentLedgerId).sort((a,b)=>parseDT(a)-parseDT(b));$("dailyReport").innerHTML=rs.length?`<table class="report-table"><thead><tr><th>时间</th><th>类型</th><th>分类</th><th>金额</th><th>标签</th></tr></thead><tbody>${rs.map(r=>`<tr><td>${esc(r.time)}</td><td>${r.type==="income"?"收入":"支出"}${r.exclude?"*":""}</td><td>${esc(categoryText(r))}</td><td>${r.type==="income"?"+":"-"}${money(r.amount)}</td><td>${esc((r.tags||[]).map(t=>"#"+t).join(" "))}</td></tr>`).join("")}</tbody></table>`:`<div class="semantic-result">当日无账单</div>`}

function weekStart(d){const x=new Date(d.getFullYear(),d.getMonth(),d.getDate()),k=(x.getDay()+6)%7;x.setDate(x.getDate()-k);x.setHours(0,0,0,0);return x}
function renderWeek(){
  const selected=$("dayDate").value||today();$("dayDate").value=selected;const sd=new Date(selected+"T12:00:00"),ws=weekStart(sd),we=new Date(ws);we.setDate(we.getDate()+6);we.setHours(23,59,59,999);
  $("weekTitle").textContent=`${ws.getMonth()+1}月${ws.getDate()}日 — ${we.getMonth()+1}月${we.getDate()}日`;
  const wr=state.records.filter(r=>r.ledgerId===state.currentLedgerId&&parseDT(r)>=ws&&parseDT(r)<=we),inc=sum(wr,"income"),exp=sum(wr,"expense");$("weekIncome").textContent=money(inc);$("weekExpense").textContent=money(exp);$("weekBalance").textContent=money(inc-exp);
  $("weekStrip").innerHTML=[0,1,2,3,4,5,6].map((i)=>{const d=new Date(ws);d.setDate(d.getDate()+i);const ds=today(d),dr=wr.filter(r=>r.date===ds),x=sum(dr,"income"),y=sum(dr,"expense"),m=state.dayMeta[ds]?.mood||"";return `<button class="week-day ${ds===selected?"active":""}" data-week-day="${ds}"><span>周${"一二三四五六日"[i]}</span><b>${d.getDate()}</b><small>${y?`-${y.toFixed(0)}`:x?`+${x.toFixed(0)}`:"—"}</small>${m?`<small>${esc(m.slice(0,4))}</small>`:""}</button>`}).join("");
  const rs=state.records.filter(r=>r.date===selected&&r.ledgerId===state.currentLedgerId).sort((a,b)=>parseDT(a)-parseDT(b)),di=sum(rs,"income"),de=sum(rs,"expense"),meta=state.dayMeta[selected]||{};
  $("dayDateLabel").textContent=new Date(selected+"T12:00:00").toLocaleDateString("zh-CN",{year:"numeric",month:"long",day:"numeric",weekday:"long"})+" · "+currentLedger().name;$("dayTitle").textContent=meta.title||"这一天";$("dayMood").textContent=meta.mood||"";$("dayNote").textContent=meta.note||"";$("dayNote").classList.toggle("hidden",!meta.note);$("dayIncome").textContent=money(di);$("dayExpense").textContent=money(de);$("dayBalance").textContent=money(di-de);
  $("dayRecords").innerHTML=rs.map(r=>`<div class="day-row"><div><b>${esc(categoryText(r))}</b><small>${esc(r.time)}${r.mood?" · "+esc(r.mood):""}${r.location?.name?" · ⌖ "+esc(r.location.name):""}${r.note?" · "+esc(r.note):""}</small></div><b style="color:${r.type==="income"?"#8ff0b4":"#ffb1b5"}">${r.type==="income"?"+":"-"}${money(r.amount)}</b></div>`).join("")||`<div class="day-row"><span>这一天还没有账单。</span></div>`;
  $("dayCard").style.backgroundImage=state.dayBackgrounds[selected]?`url("${state.dayBackgrounds[selected]}")`:"linear-gradient(145deg,#263247,#8f9aaa)";
  renderTemplates()
}
function renderTemplates(){
  $("templateStrip").innerHTML=state.templates.map(t=>`<button class="template-card" data-use-template="${t.id}"><b>${esc(t.name)}</b><small>${esc(categoryText(t))}</small><strong class="${t.type}">${t.type==="income"?"+":"-"}${money(t.amount)}</strong></button>`).join("")||`<span class="record-sub">暂无模板，点“管理”从某笔账单创建。</span>`;
}
function semanticQuery(q){
  q=q.trim();let rs=[...state.records],anchor=new Date(),period=null;
  if(/今天/.test(q))period="day";else if(/昨天/.test(q)){period="day";anchor.setDate(anchor.getDate()-1)}else if(/本周|这周/.test(q))period="week";else if(/上周/.test(q)){period="week";anchor.setDate(anchor.getDate()-7)}else if(/本月|这个月/.test(q))period="month";else if(/上月|上个月/.test(q)){period="month";anchor.setMonth(anchor.getMonth()-1)}else if(/今年/.test(q))period="year";else if(/去年/.test(q)){period="year";anchor.setFullYear(anchor.getFullYear()-1)}
  if(period){const {s,e}=range(period,anchor);rs=rs.filter(r=>{const d=parseDT(r);return d>=s&&d<=e})}
  if(/支出|花了|花费|消费/.test(q))rs=rs.filter(r=>r.type==="expense");if(/收入|收到|进账/.test(q))rs=rs.filter(r=>r.type==="income");
  const tags=allTags().filter(t=>q.includes(t));if(tags.length)rs=rs.filter(r=>tags.every(t=>(r.tags||[]).includes(t)));
  const cats=[...state.categories.expense,...state.categories.income];const names=cats.flatMap(c=>[c.name,...c.children]).filter(n=>q.includes(n));if(names.length)rs=rs.filter(r=>names.some(n=>categoryText(r).includes(n)));
  const words=q.replace(/本月|这个月|本周|这周|上周|今天|昨天|今年|去年|支出|收入|花了|花费|消费|多少|多少钱|相关|搜索|查询|的|我|和|了|？|\?/g," ").trim().split(/\s+/).filter(x=>x.length>=2);
  if(!tags.length&&!names.length&&words.length)rs=rs.filter(r=>words.some(w=>(r.note||"").includes(w)||(r.location?.name||"").includes(w)||(r.merchant||"").includes(w)||(r.tags||[]).some(t=>t.includes(w))));
  const inc=sum(rs,"income"),exp=sum(rs,"expense"),rank={};rs.filter(r=>r.type==="expense"&&counted(r)).forEach(r=>{const n=cat(r.type,r.primaryId)?.name||"未分类";rank[n]=(rank[n]||0)+Number(r.amount)});const top=Object.entries(rank).sort((a,b)=>b[1]-a[1]).slice(0,3);
  return {rs,summary:`找到 ${rs.length} 笔；收入 ${money(inc)}，支出 ${money(exp)}，结余 ${money(inc-exp)}${top.length?"。主要支出："+top.map(([n,v])=>`${n} ${money(v)}`).join("、"):"。"}`}
}
function runSemantic(){const q=$("semanticInput").value.trim();if(!q)return;const r=semanticQuery(q);$("semanticResult").classList.remove("hidden");$("semanticResult").innerHTML=`<b>${esc(r.summary)}</b>`+r.rs.slice(0,8).map(x=>`<div class="manage-row"><span>${esc(categoryText(x))}<small class="record-sub">${esc(x.date+" "+x.time)}</small></span><b class="${x.type}">${x.type==="income"?"+":"-"}${money(x.amount)}</b></div>`).join("")}

function renderCategoryPicker(){
  const cats=state.categories[rec.type]||[];if(!cats.some(c=>c.id===rec.primaryId)){rec.primaryId=cats[0]?.id||"";rec.secondary=""}
  $("primaryGrid").innerHTML=cats.map(c=>`<button class="cat-btn ${c.id===rec.primaryId?"active":""}" data-primary="${c.id}"><div class="cat-icon">${iconFor(c.name)}</div><span>${esc(c.name)}</span></button>`).join("");
  const c=cat(rec.type,rec.primaryId);$("secondaryGrid").innerHTML=(c?.children||[]).map(n=>`<button class="cat-btn ${n===rec.secondary?"active":""}" data-secondary="${esc(n)}"><div class="cat-icon">${iconFor(n)}</div><span>${esc(n)}</span></button>`).join("")
}
function updateRecordUI(){
  renderCategoryPicker();$("recordAmount").value=Number(rec.amount||0).toFixed(2);$("recordAmount").parentElement.parentElement.classList.toggle("income",rec.type==="income");$("recordDate").value=rec.date;$("recordTime").value=rec.time;$("recordTags").value=(rec.tags||[]).join(", ");$("recordNote").value=rec.note;$("qTime").textContent=rec.time;const ledger=state.ledgers.find(x=>x.id===rec.ledgerId)||currentLedger();$("qLedger").textContent=ledger.name;$("recordLedger").innerHTML=state.ledgers.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("");$("recordLedger").value=ledger.id;$("qStats").textContent=rec.exclude?(rec.type==="income"?"不计收入":"不计支出"):"计入统计";$("qStats").classList.toggle("active",rec.exclude);$("qLocation").textContent=rec.location?.name?`⌖ ${rec.location.name}`:"⌖ 位置";$("qMood").textContent=rec.mood?`${rec.mood} Mood`:"☺ Mood";$("qImage").textContent=rec.images?.length?`▧ 图片 ${rec.images.length}`:"▧ 图片";$("recordDetails").classList.add("hidden");$("editRow").classList.toggle("hidden",!editingId);$$("[data-type]").forEach(b=>b.classList.toggle("active",b.dataset.type===rec.type));syncDayChips();renderImagePreview()
}
function openRecord(r=null,repeat=false){
  editingId=r?.id||null;
  rec=r?clone(r):{type:"expense",amount:"0.00",primaryId:"food",secondary:"",date:today(),time:nowTime(),tags:[],note:"",exclude:false,location:null,images:[],mood:"",ledgerId:state.currentLedgerId};
  if(repeat){editingId=null;rec.amount="0.00";rec.date=today();rec.time=nowTime()}
  rec.ledgerId=rec.ledgerId||state.currentLedgerId;
  currentAutoCapture=(!editingId&&r?.autoRecognized)?{raw:r.captureRaw||"",source:r.captureSource||"自动识屏",confidence:r.confidence||0,merchant:r.merchant||""}:null;
  $("autoRecognizeBanner").classList.toggle("hidden",!currentAutoCapture);
  $("autoAmountWarning").classList.toggle("hidden",!(currentAutoCapture&&!Number(rec.amount)));
  $("rawCaptureBox").classList.add("hidden");
  if(currentAutoCapture){
    const bits=[currentAutoCapture.source,currentAutoCapture.merchant,currentAutoCapture.confidence?`置信度 ${currentAutoCapture.confidence}%`:""].filter(Boolean);
    $("autoRecognizeSummary").textContent=(bits.length?bits.join(" · ")+"。":"")+"金额、分类、备注均可修改后保存。";
    $("rawCaptureBox").textContent=currentAutoCapture.raw||"";
  }
  updateRecordUI();openSheet("recordSheet")
}
function syncRecordFields(){rec.ledgerId=$("recordLedger").value||state.currentLedgerId;rec.date=$("recordDate").value;rec.time=$("recordTime").value||nowTime();rec.tags=$("recordTags").value.split(/[,，]/).map(x=>x.trim().replace(/^#/,"")).filter(Boolean);rec.note=$("recordNote").value.trim()}
function pressKey(k){let v=String(rec.amount||"0");if(k==="clear")v="0";else if(k==="back")v=v.length>1?v.slice(0,-1):"0";else if(k==="."){if(!v.includes("."))v+="."}else{if(v==="0")v=k;else v+=k}if(v.includes(".")){const [a,b]=v.split(".");v=a+"."+b.slice(0,2)}rec.amount=v;updateRecordUI()}
async function saveRecord(keep=false){
  syncRecordFields();const amount=Number(rec.amount);if(!(amount>0))return showToast("请输入金额");
  const data={...rec,amount,updatedAt:Date.now(),ledgerId:rec.ledgerId||state.currentLedgerId};
  if(editingId){const i=state.records.findIndex(r=>r.id===editingId);state.records[i]={...state.records[i],...data,id:editingId}}else state.records.push({...data,id:uid("r"),createdAt:Date.now()});
  await persist();showToast(editingId?"已修改":"已保存");if(keep&&!editingId){rec.amount="0.00";rec.time=nowTime();updateRecordUI()}else{closeSheet("recordSheet");editingId=null}
}
function syncDayChips(){$$("[data-day-offset]").forEach(b=>{const d=new Date();d.setDate(d.getDate()+Number(b.dataset.dayOffset));b.classList.toggle("active",rec.date===today(d))})}
function renderImagePreview(){$("imagePreview").innerHTML=(rec.images||[]).map((im,i)=>`<div><img src="${im}"><button data-remove-img="${i}">×</button></div>`).join("")}
function compress(file,max=1000,q=.72){return new Promise(resolve=>{const rd=new FileReader();rd.onload=()=>{const img=new Image();img.onload=()=>{const s=Math.min(1,max/Math.max(img.width,img.height)),c=document.createElement("canvas");c.width=Math.round(img.width*s);c.height=Math.round(img.height*s);c.getContext("2d").drawImage(img,0,0,c.width,c.height);resolve(c.toDataURL("image/jpeg",q))};img.src=rd.result};rd.readAsDataURL(file)})}

function openLocation(){
  $("locationName").value=rec.location?.name||"";currentCoords=rec.location?.lat!=null?{lat:rec.location.lat,lng:rec.location.lng,accuracy:rec.location.accuracy}:null;$("locationStatus").textContent=window.isSecureContext?"点击下方按钮，系统会请求定位权限。":"当前不是 HTTPS 安全页面，浏览器不会开放定位权限。请部署到 HTTPS 后使用。";openSheet("locationSheet")
}
function requestLocation(){
  if(!window.isSecureContext)return $("locationStatus").textContent="无法请求：网页版定位需要 HTTPS（localhost 开发环境除外）。";
  if(!navigator.geolocation)return $("locationStatus").textContent="当前浏览器不支持定位。";
  $("locationStatus").textContent="正在请求系统定位权限…";
  navigator.geolocation.getCurrentPosition(p=>{currentCoords={lat:p.coords.latitude,lng:p.coords.longitude,accuracy:p.coords.accuracy};$("locationStatus").textContent=`定位成功：${currentCoords.lat.toFixed(5)}, ${currentCoords.lng.toFixed(5)}，精度约 ${Math.round(currentCoords.accuracy)} 米。`},e=>{$("locationStatus").textContent=e.code===1?"你拒绝了定位权限，请在系统/浏览器设置中重新允许。":"定位失败："+e.message},{enableHighAccuracy:true,timeout:12000,maximumAge:30000})
}

function renderLedgerManager(){$("ledgerManager").innerHTML=state.ledgers.map(l=>`<div class="manage-row"><b>${esc(l.name)}${l.id===state.currentLedgerId?" · 当前":""}</b><div class="manage-actions"><button data-ledger-use="${l.id}">使用</button><button data-ledger-rename="${l.id}">改名</button>${state.ledgers.length>1?`<button data-ledger-delete="${l.id}">删除</button>`:""}</div></div>`).join("")}
function renderCategoryManager(){$$(".category-manage-tabs button").forEach(b=>b.classList.toggle("active",b.dataset.catType===categoryManageType));$("categoryManager").innerHTML=(state.categories[categoryManageType]||[]).map(c=>`<div class="manage-row"><div><b>${iconFor(c.name)} ${esc(c.name)}</b><div class="record-sub">${esc(c.children.join("、")||"暂无二级分类")}</div></div><div class="manage-actions"><button data-cat-children="${c.id}">二级</button><button data-cat-rename="${c.id}">改名</button><button data-cat-delete="${c.id}">删除</button></div></div>`).join("")}
function renderTemplateManager(){
  $("templateManager").innerHTML=state.templates.map(t=>`<div class="manage-row"><span><b>${esc(t.name)}</b><div class="record-sub">${esc(categoryText(t))} · ${money(t.amount)}</div></span><div class="manage-actions"><button data-template-use="${t.id}">使用</button><button data-template-delete="${t.id}">删除</button></div></div>`).join("")||`<div class="semantic-result">暂无模板</div>`;
  const ds=$("dayDate").value||today(),rs=state.records.filter(r=>r.date===ds&&r.ledgerId===state.currentLedgerId);$("templateSources").innerHTML=rs.map(r=>`<div class="manage-row"><span>${esc(categoryText(r))} · ${money(r.amount)}</span><button data-template-from="${r.id}">设为模板</button></div>`).join("")||`<div class="semantic-result">当前日暂无账单</div>`
}
function useTemplate(id){const t=state.templates.find(x=>x.id===id);if(!t)return;closeAll();openRecord({...clone(t),id:null,date:$("dayDate").value||today(),time:nowTime(),ledgerId:state.currentLedgerId})}
function extractMoney(text){
  const rules=[
    /(?:支付金额|付款金额|实付款|实付|交易金额|订单金额|收款金额|到账金额|退款金额)\s*[:：]?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/i,
    /[¥￥]\s*(\d+(?:\.\d{1,2})?)/,
    /(?:支付|付款|消费|收款|到账|退款|转账)[^\d]{0,10}(\d+(?:\.\d{1,2})?)\s*(?:元|块|块钱)?/
  ];
  for(const re of rules){const m=text.match(re);if(m){const n=Number(m[1]);if(n>0&&n<1000000)return n}}
  const nums=[...text.matchAll(/(?<![\d])(\d+(?:\.\d{1,2})?)(?![\d])/g)].map(m=>Number(m[1])).filter(n=>n>0&&n<100000);
  const decimals=nums.filter(n=>!Number.isInteger(n));return decimals[0]??nums.find(n=>n<10000)??0
}
function extractMerchant(text){
  const known=["瑞幸咖啡","星巴克","海底捞","麦当劳","肯德基","美团外卖","饿了么","滴滴出行","高德打车","铁路12306","盒马","山姆","京东","淘宝","拼多多","携程","去哪儿"];
  const exact=known.find(x=>text.includes(x));if(exact)return exact;
  const lines=text.split(/\n+/).map(x=>x.trim()).filter(Boolean);
  const blacklist=/微信|支付宝|支付成功|付款成功|交易成功|收款成功|账单|订单|商户|支付方式|付款方式|交易时间|时间|¥|￥|金额|余额|银行卡|零钱|花呗|信用卡|完成|返回|详情|转账|收款|\d{4}[-/.]\d{1,2}/;
  return lines.find(x=>x.length>=2&&x.length<=24&&!blacklist.test(x))||""
}
function classifyCapture(text,type,merchant,time){
  const t=(text+" "+merchant);
  const rules=[
    [/瑞幸|星巴克|咖啡/,["food","咖啡"]],
    [/海底捞|火锅|晚餐/,["food","晚餐"]],
    [/早餐|豆浆|包子|早餐店/,["food","早餐"]],
    [/午餐|午饭/,["food","午餐"]],
    [/麦当劳|肯德基|美团外卖|饿了么|餐厅|饭店|餐饮/,["food",""]],
    [/滴滴|高德打车|出租车|网约车/,["transport","打车"]],
    [/地铁/,["transport","地铁"]],
    [/公交/,["transport","公交"]],
    [/12306|铁路|高铁|动车/,["transport","高铁"]],
    [/酒店|民宿|携程|去哪儿/,["travel-e","住宿"]],
    [/门票|景区/,["travel-e","门票"]],
    [/医院|门诊|药房|药店/,["medical",""]],
    [/话费|中国移动|中国电信|中国联通|宽带/,["network",""]],
    [/淘宝|京东|拼多多|盒马|山姆|商场|超市/,["shopping",""]]
  ];
  if(type==="income"){
    if(/退款|退回/.test(t))return ["refund-i","退款"];
    if(/工资|薪资/.test(t))return ["salary",""];
    if(/红包/.test(t))return ["gift-i","红包"];
    if(/转账|收款/.test(t))return ["gift-i","转账"];
    return ["other-i",""]
  }
  for(const [re,pair] of rules)if(re.test(t))return pair;
  const h=Number((time||"12:00:00").slice(0,2));if(/餐|饭|食堂/.test(t))return ["food",h<10?"早餐":h<15?"午餐":"晚餐"];
  return ["other-e",""]
}
function extractDateTime(text){
  let date=today(),time=nowTime(),m;
  m=text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/);if(m)date=`${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m=text.match(/\b([01]?\d|2[0-3])[:：]([0-5]\d)(?:[:：]([0-5]\d))?\b/);if(m)time=`${pad(m[1])}:${m[2]}:${m[3]||"00"}`;
  const d=new Date();if(/昨天/.test(text)){d.setDate(d.getDate()-1);date=today(d)}else if(/前天/.test(text)){d.setDate(d.getDate()-2);date=today(d)}else if(/大前天/.test(text)){d.setDate(d.getDate()-3);date=today(d)}
  return {date,time}
}
function detectPaymentSource(text){
  if(/支付宝|花呗/.test(text))return "支付宝";
  if(/微信|零钱通|零钱/.test(text))return "微信支付";
  if(/云闪付/.test(text))return "云闪付";
  return "识屏"
}
async function parseNatural(text,source="文字"){
  return parseBookkeepingText({text,source,categories:state.categories,knownTags:allTags(),defaultLedgerId:state.currentLedgerId});
}
async function handleAutoBook(text,source="自动记账磁贴"){
  const c=await parseNatural(text,source);
  closeAll();
  openRecord({...c,id:null});
  $("autoAmountWarning").classList.toggle("hidden",!!c.amount);
  if(!c.amount)showToast("未识别到金额，请补充");
  else showToast("已自动填入，可修改后保存");
  return c
}
function showCandidate(c){aiCandidate=c;$("aiCandidate").classList.remove("hidden");$("aiCandidate").innerHTML=`<div>${esc(c.source)} · 置信度 ${c.confidence}%</div><div class="amount ${c.type}">${c.type==="income"?"+":"-"}${money(c.amount)}</div><b>${esc(categoryText(c))}</b><div class="record-sub">${esc(c.date+" "+c.time)}${c.merchant?" · "+esc(c.merchant):""}</div><div class="candidate-actions"><button id="candidateEdit">调整</button><button id="candidateSave">直接保存</button></div>`;$("candidateEdit").onclick=()=>{closeSheet("aiSheet");openRecord({...c,id:null})};$("candidateSave").onclick=async()=>{if(!c.amount)return showToast("未识别到金额");state.records.push({id:uid("quick"),...c,createdAt:Date.now(),updatedAt:Date.now()});await persist();closeSheet("aiSheet");showToast("快记已保存")}}
function switchAI(mode){$$("[data-ai]").forEach(b=>b.classList.toggle("active",b.dataset.ai===mode));["Text","Voice","Image","Shortcut"].forEach(n=>$(`ai${n}Pane`).classList.add("hidden"));$(`ai${mode[0].toUpperCase()+mode.slice(1)}Pane`).classList.remove("hidden")}
function startVoice(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SR)return showToast("当前浏览器不支持语音识别");
  const r=new SR();r.lang="zh-CN";r.interimResults=false;r.continuous=false;r.maxAlternatives=5;$("voiceText").textContent="正在聆听…";
  r.onresult=async e=>{const alternatives=Array.from(e.results[0]||[]).map(x=>x.transcript?.trim()).filter(Boolean);let text=alternatives[0]||"",candidate=await parseNatural(text,"语音");for(const alternative of alternatives.slice(1)){if(candidate.amount)break;const parsed=await parseNatural(alternative,"语音");if(parsed.amount){text=alternative;candidate=parsed}}$("voiceText").textContent=text||"没有听清，请再说一次";showCandidate(candidate)};
  r.onerror=e=>{$("voiceText").textContent=e.error==="not-allowed"?"麦克风权限未开启，请在浏览器设置中允许":e.error==="no-speech"?"没有听到语音，请靠近麦克风再试":e.error==="network"?"语音服务网络连接失败，请稍后再试":"语音识别失败，请重试"};
  try{r.start()}catch(err){console.error(err);$("voiceText").textContent="无法启动语音识别，请检查麦克风权限"}
}

async function action(e){
  const b=e.target.closest("button,[data-act]");if(!b)return;
  if(b.dataset.act){const r=state.records.find(x=>x.id===b.dataset.id);if(!r)return;if(b.dataset.act==="repeat")openRecord(r,true);if(b.dataset.act==="edit")openRecord(r);if(b.dataset.act==="delete"){if(confirm("确定删除这笔账单？")){state.records=state.records.filter(x=>x.id!==r.id);await persist()}}if(b.dataset.act==="refund"){const v=prompt("退款金额",r.amount);if(v&&Number(v)>0){const type=r.type==="expense"?"income":"expense",c=type==="income"?cat("income","refund-i"):cat("expense","other-e");state.records.push({id:uid("refund"),ledgerId:r.ledgerId,type,amount:Number(v),date:today(),time:nowTime(),primaryId:c?.id||"",secondary:type==="income"?"退款":"",tags:[...(r.tags||[]),"退款"],note:"退款："+(r.note||categoryText(r)),exclude:false,location:null,images:[],mood:"",createdAt:Date.now(),updatedAt:Date.now(),refundOf:r.id});await persist()}}}
}

function renderSystemInfo(){const cloud=getCloudStatus(),account=cloud.account?.email||"未登录";$('accountLabel').textContent=account;$('cloudAccountButton').textContent=cloud.account?.displayName||"云端";$('cloudSyncStatus').textContent=document.body.dataset.sync==="error"?"保存失败":document.body.dataset.sync==="syncing"?"同步中":"已同步";$('cloudSyncStatus').classList.toggle("sync-error",document.body.dataset.sync==="error");$("systemInfo").innerHTML=`数据存储：简账云端（本机不保存正式账单）<br>云端账号：${esc(account)}<br>最近同步：${cloud.updatedAt?esc(new Date(cloud.updatedAt).toLocaleString("zh-CN")):"尚未写入"}<br>安全上下文：${window.isSecureContext?"是，可申请定位权限":"否，定位等权限会受限"}<br>PWA Service Worker：${"serviceWorker" in navigator?"支持":"不支持"}<br>当前账本：${esc(currentLedger().name)}`}
function renderAll(){applyFont();renderHome();renderRecords();renderStats();renderWeek();renderSystemInfo();$("ledgerSwitch").textContent=currentLedger().name+"⌄"}

function knownTags(){return [...new Set(state.records.flatMap(record=>record.tags||[]))]}
async function importBillFile(file,parser,label){
  if(!file)return;
  const status=$("billImportStatus");status.classList.remove("hidden");status.textContent=`正在读取${label}…`;
  try{
    const result=await parser(file,{categories:state.categories,knownTags:knownTags(),ledgerId:state.currentLedgerId});
    const existingKeys=new Set(state.records.map(record=>record.provider&&record.externalId?`${record.provider}:${record.externalId}`:record.id));
    const additions=[];let duplicates=0;
    for(const record of result.records){const key=record.provider&&record.externalId?`${record.provider}:${record.externalId}`:record.id;if(existingKeys.has(key)){duplicates+=1;continue}existingKeys.add(key);additions.push(record)}
    if(!additions.length){status.textContent=`${label}没有新增流水；已跳过 ${duplicates} 条重复记录。`;showToast("没有需要新增的流水");return}
    if(!confirm(`${label}识别到 ${additions.length} 条新流水，${result.excluded} 条将不计入统计。确认导入当前账本吗？`)){status.textContent="已取消导入";return}
    state.records.push(...additions);
    if(!await persist()){state.records=state.records.filter(record=>!additions.some(item=>item.id===record.id));throw new Error("云端保存失败，未完成导入")}
    status.textContent=`${label}导入完成：新增 ${additions.length} 条，重复 ${duplicates} 条，无效/关闭 ${result.skipped} 条，不计入统计 ${result.excluded} 条。`;
    showToast(`${label}已导入 ${additions.length} 条`)
  }catch(err){console.error(err);status.textContent=`${label}导入失败：${err?.message||"文件格式无效"}`;showToast(`${label}导入失败`)}
}

function bind(){
  document.addEventListener("click",action);$("cloudAccountButton").onclick=()=>navigate("settings");
  $$("[data-nav]").forEach(b=>b.onclick=()=>navigate(b.dataset.nav));$("homeAdd").onclick=$("navAdd").onclick=()=>openRecord();$("homeAI").onclick=()=>openSheet("aiSheet");$("openSettings").onclick=()=>navigate("settings");$("ledgerSwitch").onclick=()=>{renderLedgerManager();openSheet("ledgerSheet")};
  $$("[data-close]").forEach(b=>b.onclick=()=>closeSheet(b.dataset.close));$("backdrop").onclick=closeAll;
  $$("[data-type]").forEach(b=>b.onclick=()=>{rec.type=b.dataset.type;rec.primaryId=(state.categories[rec.type]||[])[0]?.id||"";rec.secondary="";updateRecordUI()});
  $("primaryGrid").onclick=e=>{const b=e.target.closest("[data-primary]");if(!b)return;rec.primaryId=b.dataset.primary;rec.secondary="";updateRecordUI()};$("secondaryGrid").onclick=e=>{const b=e.target.closest("[data-secondary]");if(!b)return;rec.secondary=b.dataset.secondary;updateRecordUI()};
  $$("[data-day-offset]").forEach(b=>b.onclick=()=>{const d=new Date();d.setDate(d.getDate()+Number(b.dataset.dayOffset));rec.date=today(d);updateRecordUI()});
  $("qTime").onclick=()=>$("recordDetails").classList.toggle("hidden");$("qTags").onclick=$("keyTag").onclick=()=>$("recordDetails").classList.toggle("hidden");$("qStats").onclick=()=>{rec.exclude=!rec.exclude;updateRecordUI()};$("qLocation").onclick=openLocation;$("qImage").onclick=()=>$("recordImageInput").click();$("qMood").onclick=()=>openSheet("moodSheet");$("qTemplate").onclick=()=>{renderTemplateManager();openSheet("templateSheet")};
  $$(".keypad [data-key]").forEach(b=>b.onclick=()=>pressKey(b.dataset.key));$("saveRecord").onclick=()=>saveRecord(false);$("repeatSave").onclick=()=>saveRecord(true);
  $("qLedger").onclick=()=>$("recordDetails").classList.remove("hidden");$("recordLedger").onchange=()=>{rec.ledgerId=$("recordLedger").value;updateRecordUI();$("recordDetails").classList.remove("hidden")};$("recordDate").onchange=()=>{rec.date=$("recordDate").value;syncDayChips()};$("recordTime").onchange=()=>{rec.time=$("recordTime").value;$("qTime").textContent=rec.time};$("recordNote").oninput=()=>rec.note=$("recordNote").value;$("recordTags").oninput=()=>rec.tags=$("recordTags").value.split(/[,，]/).map(x=>x.trim()).filter(Boolean);
  $("recordImageInput").onchange=async e=>{const fs=Array.from(e.target.files||[]).slice(0,3-(rec.images?.length||0));for(const f of fs)rec.images.push(await compress(f));renderImagePreview();updateRecordUI();e.target.value=""};$("imagePreview").onclick=e=>{const b=e.target.closest("[data-remove-img]");if(b){rec.images.splice(Number(b.dataset.removeImg),1);renderImagePreview();updateRecordUI()}};
  $("requestLocation").onclick=requestLocation;$("saveLocation").onclick=()=>{const name=$("locationName").value.trim();if(!name&&!currentCoords)return showToast("请先定位或填写地点");rec.location={name:name||(currentCoords?"当前位置":""),lat:currentCoords?.lat??null,lng:currentCoords?.lng??null,accuracy:currentCoords?.accuracy??null};closeSheet("locationSheet");updateRecordUI()};$("clearLocation").onclick=()=>{rec.location=null;currentCoords=null;closeSheet("locationSheet");updateRecordUI()};
  $$("[data-mood]").forEach(b=>b.onclick=()=>{rec.mood=b.dataset.mood;closeSheet("moodSheet");updateRecordUI()});$("saveMood").onclick=()=>{rec.mood=$("customMood").value.trim();closeSheet("moodSheet");updateRecordUI()};$("clearMood").onclick=()=>{rec.mood="";closeSheet("moodSheet");updateRecordUI()};
  $("editDelete").onclick=async()=>{if(editingId&&confirm("确定删除？")){state.records=state.records.filter(x=>x.id!==editingId);await persist();closeSheet("recordSheet")}};$("editRefund").onclick=()=>{const id=editingId;closeSheet("recordSheet");document.querySelector(`[data-act="refund"][data-id="${id}"]`)?.click()};
  $("recordTypeFilter").onchange=$("recordTagFilter").onchange=renderRecords;$("statsPeriod").onchange=$("statsDate").onchange=renderStats;$("semanticBtn").onclick=runSemantic;$("semanticInput").onkeydown=e=>{if(e.key==="Enter")runSemantic()};$$("[data-query]").forEach(b=>b.onclick=()=>{$("semanticInput").value=b.dataset.query;runSemantic()});
  $("weekStrip").onclick=e=>{const b=e.target.closest("[data-week-day]");if(b){$("dayDate").value=b.dataset.weekDay;renderWeek()}};$("prevWeek").onclick=()=>{const d=new Date($("dayDate").value+"T12:00:00");d.setDate(d.getDate()-7);$("dayDate").value=today(d);renderWeek()};$("nextWeek").onclick=()=>{const d=new Date($("dayDate").value+"T12:00:00");d.setDate(d.getDate()+7);$("dayDate").value=today(d);renderWeek()};$("weekToday").onclick=()=>{$("dayDate").value=today();renderWeek()};
  $("editDay").onclick=()=>{const m=state.dayMeta[$("dayDate").value]||{};$("editDayTitle").value=m.title||"";$("editDayMood").value=m.mood||"";$("editDayNote").value=m.note||"";openSheet("dayEditSheet")};$("saveDayMeta").onclick=async()=>{state.dayMeta[$("dayDate").value]={title:$("editDayTitle").value.trim(),mood:$("editDayMood").value.trim(),note:$("editDayNote").value.trim()};await persist();closeSheet("dayEditSheet")};
  $("dayBgInput").onchange=async e=>{const f=e.target.files?.[0];if(f){state.dayBackgrounds[$("dayDate").value]=await compress(f,1400,.76);await persist()}e.target.value=""};$("clearDayBg").onclick=async()=>{delete state.dayBackgrounds[$("dayDate").value];await persist()};
  $("manageTemplates").onclick=()=>{renderTemplateManager();openSheet("templateSheet")};$("templateStrip").onclick=e=>{const b=e.target.closest("[data-use-template]");if(b)useTemplate(b.dataset.useTemplate)};$("templateManager").onclick=async e=>{const u=e.target.closest("[data-template-use]"),d=e.target.closest("[data-template-delete]");if(u)useTemplate(u.dataset.templateUse);if(d){state.templates=state.templates.filter(t=>t.id!==d.dataset.templateDelete);await persist();renderTemplateManager()}};$("templateSources").onclick=async e=>{const b=e.target.closest("[data-template-from]");if(!b)return;const r=state.records.find(x=>x.id===b.dataset.templateFrom),name=prompt("模板名称",r.secondary||cat(r.type,r.primaryId)?.name||"常用记账");if(name){state.templates.push({id:uid("tpl"),name,type:r.type,amount:r.amount,primaryId:r.primaryId,secondary:r.secondary,tags:r.tags||[],note:r.note||"",exclude:r.exclude,mood:r.mood||"",location:r.location||null,images:[]});await persist();renderTemplateManager()}};
  $("manageLedgers").onclick=()=>{renderLedgerManager();openSheet("ledgerSheet")};$("ledgerManager").onclick=async e=>{const u=e.target.closest("[data-ledger-use]"),rn=e.target.closest("[data-ledger-rename]"),d=e.target.closest("[data-ledger-delete]");if(u){state.currentLedgerId=u.dataset.ledgerUse;await persist();renderLedgerManager()}if(rn){const l=state.ledgers.find(x=>x.id===rn.dataset.ledgerRename),v=prompt("账本名称",l.name);if(v){l.name=v.trim();await persist();renderLedgerManager()}}if(d&&confirm("删除账本会删除其中账单，确定？")){const id=d.dataset.ledgerDelete;state.ledgers=state.ledgers.filter(x=>x.id!==id);state.records=state.records.filter(r=>r.ledgerId!==id);state.currentLedgerId=state.ledgers[0].id;await persist();renderLedgerManager()}};
  $("addLedger").onclick=async()=>{const v=$("newLedger").value.trim();if(v){state.ledgers.push({id:uid("ledger"),name:v});$("newLedger").value="";await persist();renderLedgerManager()}};
  $("manageCategories").onclick=()=>{renderCategoryManager();openSheet("categorySheet")};$$("[data-cat-type]").forEach(b=>b.onclick=()=>{categoryManageType=b.dataset.catType;renderCategoryManager()});$("categoryManager").onclick=async e=>{const rr=e.target.closest("[data-cat-rename]"),ch=e.target.closest("[data-cat-children]"),del=e.target.closest("[data-cat-delete]");if(rr){const c=cat(categoryManageType,rr.dataset.catRename),v=prompt("分类名称",c.name);if(v){c.name=v.trim();await persist();renderCategoryManager()}}if(ch){const c=cat(categoryManageType,ch.dataset.catChildren),v=prompt("二级分类，用逗号分隔",c.children.join(","));if(v!==null){c.children=v.split(/[,，]/).map(x=>x.trim()).filter(Boolean);await persist();renderCategoryManager()}}if(del&&confirm("删除这个分类？")){state.categories[categoryManageType]=state.categories[categoryManageType].filter(c=>c.id!==del.dataset.catDelete);await persist();renderCategoryManager()}};
  $("addCategory").onclick=async()=>{const v=$("newCategory").value.trim();if(v){state.categories[categoryManageType].push({id:uid("cat"),name:v,children:[]});$("newCategory").value="";await persist();renderCategoryManager()}};
  $("importWechat").onchange=async e=>{const file=e.target.files?.[0];await importBillFile(file,parseWechatExcel,"微信账单");e.target.value=""};
  $("importAlipay").onchange=async e=>{const file=e.target.files?.[0];await importBillFile(file,parseAlipayCsv,"支付宝账单");e.target.value=""};
  $("fontPreset").onchange=()=>{$("customFontRow").classList.toggle("hidden",$("fontPreset").value!=="custom")};
  $("saveFont").onclick=async()=>{const preset=$("fontPreset").value,custom=$("customFont").value.trim();if(preset==="custom"&&!custom)return showToast("请填写已安装字体名称");state.settings={...(state.settings||{}),fontPreset:preset,customFont:custom};applyFont();if(await persist())showToast("字体设置已保存")};
  $$("[data-ai]").forEach(b=>b.onclick=()=>switchAI(b.dataset.ai));$("parseAI").onclick=async()=>showCandidate(await parseNatural($("aiText").value,"文字"));$("startVoice").onclick=startVoice;$("aiImageInput").onchange=e=>{const f=e.target.files?.[0];if(!f)return;const rd=new FileReader();rd.onload=()=>{$("aiImagePreview").src=rd.result;$("aiImagePreview").classList.remove("hidden")};rd.readAsDataURL(f)};$("parseOCR").onclick=async()=>showCandidate(await parseNatural($("ocrText").value,"截图 OCR"));$("parseShortcut").onclick=async()=>handleAutoBook($("shortcutText").value,"iOS 快捷指令磁贴");
  $("exportData").onclick=async()=>{try{showToast("正在从云端生成备份…");const backup=await exportCloudState(),blob=new Blob([JSON.stringify(backup,null,2)],{type:"application/json"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`简账云端备份_${today()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);showToast("云端备份已导出")}catch(err){showToast(err?.message||"导出失败")}};$("importData").onchange=async e=>{const f=e.target.files?.[0];if(!f)return;try{const backup=JSON.parse(await f.text());if(!confirm("导入会覆盖当前云端账本，确定继续？"))return;state=normalize(await importCloudState(backup));renderAll();showToast("已导入云端")}catch(err){showToast(err?.message||"备份文件无效")}finally{e.target.value=""}};
  $("autoTileSettings").onclick=()=>openSheet("autoTileSheet");
  $("simulateTile").onclick=async()=>handleAutoBook($("tileSimText").value,"磁贴模拟");
  $("showRawCapture").onclick=()=>$("rawCaptureBox").classList.toggle("hidden");
  $("locationTest").onclick=()=>{openLocation();requestLocation()};$("installHelp").onclick=()=>alert("正式 PWA 部署到 HTTPS 后：iPhone 可在 Safari 分享菜单中选择“添加到主屏幕”；Windows/Android 支持的浏览器会显示安装入口。");
  $("voiceFromRecord").onclick=()=>{closeSheet("recordSheet");openSheet("aiSheet");switchAI("voice")};
}

async function init(){
  try{
    state=normalize(await loadState());
    document.body.dataset.sync="saved";
    $("statsDate").value=today();$("dayDate").value=today();
    bind();renderAll();
    if("serviceWorker" in navigator&&location.protocol.startsWith("http"))navigator.serviceWorker.register("./sw.js").catch(()=>{});
    const qp=new URLSearchParams(location.search),autoText=qp.has("text")?qp.get("text"):(qp.get("quick")||""),isAuto=qp.get("autobook")==="1"||qp.has("quick");
    if(isAuto)setTimeout(()=>handleAutoBook(autoText,"iOS 快捷指令磁贴"),180);
  }catch(err){console.error(err);if(err instanceof CloudStorageError&&err.code==="AUTH_REQUIRED"){showAuthGate();return}$("fatalError").classList.remove("hidden");$("fatalError").textContent="简账启动失败\n\n"+(err?.message||err)}
}
function showAuthGate(){document.body.classList.add("auth-required");$("authGate").classList.remove("hidden");const returnTo=location.pathname+location.search+location.hash;$("authLogin").href=`/signin-with-chatgpt?return_to=${encodeURIComponent(returnTo)}`}
window.addEventListener("error",e=>{console.error(e.error||e.message)});
init();
