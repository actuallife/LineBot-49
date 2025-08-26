// pages/api/webhook.js
import getRawBody from "raw-body";
import crypto from "crypto";
export const config = { api: { bodyParser: false } };

// ===== Env =====
const SECRET = process.env.LINE_CHANNEL_SECRET;
const TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

// ===== 指令正規化 =====
function toHalfWidth(s) {
  return String(s || "")
    .replace(/\u3000/g, " ")
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}
function normCmd(s) { return toHalfWidth(s).trim().toLowerCase(); }
function isCmd(cmd, list) { return list.includes(cmd); }

// ===== Helpers =====
function validSig(raw, sig) {
  const mac = crypto.createHmac("sha256", SECRET).update(raw).digest("base64");
  return mac === sig;
}
function todayKey(tz = "Asia/Taipei") {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(d);
  const y = parts.find(p=>p.type==="year").value;
  const m = parts.find(p=>p.type==="month").value;
  const da= parts.find(p=>p.type==="day").value;
  return `${y}-${m}-${da}`;
}
function chunk(lines, limit = 4500) {
  const out=[]; let buf="";
  for (const line of lines) { const add=(buf?"\n":"")+line; if ((buf+add).length>limit){ if(buf) out.push(buf); buf=line; } else buf+=add; }
  if (buf) out.push(buf); return out;
}
function fmtKey(d, tz="Asia/Taipei") {
  const p = new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(d);
  const y=p.find(x=>x.type==="year").value, m=p.find(x=>x.type==="month").value, da=p.find(x=>x.type==="day").value;
  return `${y}-${m}-${da}`;
}
function lastNDates(n, tz="Asia/Taipei"){
  const out=[]; const now=new Date();
  for(let i=0;i<n;i++){ out.push(fmtKey(new Date(now.getTime()-i*86400000), tz)); }
  return out.reverse();
}
function monthDates(ym, tz="Asia/Taipei"){ // ym: "YYYY-MM"
  const [Y,M]=ym.split("-").map(Number);
  const first = new Date(Date.UTC(Y, M-1, 1));
  const next  = new Date(Date.UTC(Y, M,   1));
  const out=[]; for(let d=new Date(first); d<next; d.setUTCDate(d.getUTCDate()+1)) out.push(fmtKey(new Date(d), tz));
  return out;
}

// ===== LINE API =====
async function call(endpoint, init={}) {
  return fetch(`https://api.line.me${endpoint}`, {
    ...init,
    headers: { Authorization:`Bearer ${TOKEN}`, "Content-Type":"application/json", ...(init.headers||{}) }
  });
}
async function reply(replyToken, messages) {
  const payload = Array.isArray(messages) ? { replyToken, messages } : { replyToken, messages:[messages] };
  await call("/v2/bot/message/reply", { method:"POST", body: JSON.stringify(payload) });
}
async function push(to, texts) {
  if (!texts.length) return;
  await call("/v2/bot/message/push", { method:"POST", body: JSON.stringify({ to, messages:texts.map(t=>({type:"text", text:t})) }) });
}
async function getProfile(srcType, chatId, userId) {
  const base = srcType==="group" ? `/v2/bot/group/${chatId}` : `/v2/bot/room/${chatId}`;
  const r = await call(`${base}/member/${userId}`, { method:"GET", headers:{ "Content-Type": undefined } });
  if (!r.ok) return null;
  const j = await r.json();
  return { userId, displayName: j.displayName || userId };
}
async function membersCount(srcType, chatId) {
  const base = srcType==="group" ? `/v2/bot/group/${chatId}` : `/v2/bot/room/${chatId}`;
  const r = await call(`${base}/members/count`, { method:"GET", headers:{ "Content-Type": undefined } });
  if (!r.ok) return null; const j = await r.json(); return j.count ?? null;
}

// ===== Storage: Redis 或記憶體 =====
const mem = { members:new Map(), done:new Map() };
async function redisExec(command) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error("no-redis");
  const r = await fetch(REDIS_URL, { method:"POST", headers:{ Authorization:`Bearer ${REDIS_TOKEN}`, "Content-Type":"application/json" }, body: JSON.stringify({ command }) });
  if (!r.ok) throw new Error(`redis ${r.status}`);
  return r.json();
}
const keyMembers = (chatId)=>`group:${chatId}:members`;             // HASH uid->name
const keyDone    = (chatId,date)=>`group:${chatId}:done:${date}`;   // SET of uid

async function saveMember(chatId, uid, name) {
  try { await redisExec(["HSET", keyMembers(chatId), uid, name]); }
  catch { let m=mem.members.get(chatId); if(!m){m=new Map(); mem.members.set(chatId,m);} m.set(uid,name); }
}
async function getAllMembers(chatId) {
  try {
    const j = await redisExec(["HGETALL", keyMembers(chatId)]);
    const arr = j.result || []; const out=[];
    for (let i=0;i<arr.length;i+=2) out.push({ userId:arr[i], displayName:arr[i+1] });
    return out;
  } catch {
    const m = mem.members.get(chatId) || new Map();
    return Array.from(m, ([userId, displayName]) => ({ userId, displayName }));
  }
}
async function markDone(chatId, dateKey, uid) {
  try { await redisExec(["SADD", keyDone(chatId,dateKey), uid]); }
  catch { let d=mem.done.get(chatId); if(!d){d=new Map(); mem.done.set(chatId,d);} let s=d.get(dateKey); if(!s){s=new Set(); d.set(dateKey,s);} s.add(uid); }
}
async function getDoneUids(chatId, dateKey) {
  try { const j = await redisExec(["SMEMBERS", keyDone(chatId,dateKey)]); return j.result || []; }
  catch { const d=mem.done.get(chatId); const s=d?.get(dateKey); return s?Array.from(s):[]; }
}

// ===== Handler =====
export default async function handler(req, res) {
  if (req.method==="GET" || req.method==="HEAD" || req.method==="OPTIONS") return res.status(200).send("ok");
  if (req.method!=="POST") return res.status(405).end();

  let raw; try { raw = await getRawBody(req); } catch { return res.status(400).end("Bad Request"); }
  const sig = req.headers["x-line-signature"] || "";
  if (!validSig(raw, sig)) return res.status(403).end("Forbidden");

  let body; try { body = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).end("Bad Request"); }

  try {
    await Promise.all((body.events||[]).map(async (e)=>{
      const type = e.type;
      const srcType = e.source?.type; // user | group | room
      const chatId  = e.source?.groupId || e.source?.roomId;
      const uid     = e.source?.userId;
      const isText  = type==="message" && e.message?.type==="text";
      const rawText = isText ? (e.message.text||"") : "";
      const cmd     = normCmd(rawText);               // 只用來比對指令
      const rawNorm = toHalfWidth(rawText).trim();    // 保留原大小寫與中文字供參數解析
      const lower   = rawNorm.toLowerCase();

      if (srcType!=="group" && srcType!=="room") {
        if (isText && ([ "/d","/s","/a","/?","/help","/h" ].includes(cmd) || lower.startsWith("/reg"))) {
          await reply(e.replyToken,{type:"text",text:"請在群組使用指令。"});
        }
        return;
      }

      // 發話或加入時嘗試登錄
      if (uid && (isText || type==="memberJoined")) {
        const prof = await getProfile(srcType, chatId, uid).catch(()=>null);
        if (prof) await saveMember(chatId, prof.userId, prof.displayName);
      }
      if (type==="memberJoined" && Array.isArray(e.joined?.members)) {
        for (const m of e.joined.members) if (m.userId) {
          const p = await getProfile(srcType, chatId, m.userId).catch(()=>null);
          if (p) await saveMember(chatId, p.userId, p.displayName);
        }
      }

      // ===== /reg [姓名] =====
      if (isText && (lower === "/reg" || lower.startsWith("/reg "))) {
        if (!uid) return;
        // 取參數：去掉 '/reg'，保留中文字，收斂空白
        let nameArg = rawNorm.slice(4).trim().replace(/\s+/g, " ");
        // 限長與去除換行
        nameArg = nameArg.replace(/[\r\n]/g, "").slice(0, 50);

        let finalName = nameArg;
        if (!finalName) {
          const p = await getProfile(srcType, chatId, uid).catch(()=>null);
          finalName = p?.displayName || uid;
        }
        await saveMember(chatId, uid, finalName);
        await reply(e.replyToken,{ type:"text", text:`已登錄：${finalName}` });
        return;
      }

      // ===== /d 今日完成 =====
      if (isText && isCmd(cmd, ["/d","d"])) {
        if (uid) {
          const date = todayKey();
          const p = await getProfile(srcType, chatId, uid).catch(()=>null);
          if (p) await saveMember(chatId, p.userId, p.displayName);
          await markDone(chatId, date, uid);
          await reply(e.replyToken, { type:"text", text:`已記錄：${date}` });
        }
        return;
      }

      // ===== /s 今日清單 =====
      if (isText && isCmd(cmd, ["/s","s"])) {
        const date = todayKey();
        const [all, doneUids, totalCnt] = await Promise.all([
          getAllMembers(chatId),
          getDoneUids(chatId, date),
          membersCount(srcType, chatId)
        ]);
        const nameById = new Map(all.map(m=>[m.userId, m.displayName]));
        const done = [], undone = [];
        for (const [id, name] of nameById.entries()) (doneUids.includes(id) ? done : undone).push(name || id);
        done.sort((a,b)=>a.localeCompare(b,"zh-Hant"));
        undone.sort((a,b)=>a.localeCompare(b,"zh-Hant"));

        const title = `[${date}] 定課狀態：已完成 ${done.length}/${totalCnt ?? (done.length+undone.length)}`;
        const parts = [];
        parts.push(...chunk([title, `— 已完成（${done.length}）`, ...(done.length?done:["（無）"]) ]));
        parts.push(...chunk([`— 未完成（${undone.length}）`, ...(undone.length?undone:["（無）"]) ]));

        await reply(e.replyToken, { type:"text", text: parts[0] });
        if (parts.length>1) await push(chatId, parts.slice(1));
        return;
      }

      // ===== /a 全部名單 =====
      if (isText && isCmd(cmd, ["/a","a"])) {
        const all   = await getAllMembers(chatId);
        const names = all.map(m => m.displayName).sort((a,b)=>a.localeCompare(b,"zh-Hant"));
        const title = `已經登錄名單（${names.length}人）`;
        const blocks = chunk([title, ...names]);
        await reply(e.replyToken, { type: "text", text: blocks[0] });
        if (blocks.length > 1) await push(chatId, blocks.slice(1));
        return;
      }
      // ===== /stats 區間統計：/stats 7 或 /stats 2025-08 =====
      if (isText && (cmd.startsWith("/stats") || cmd === "stats")) {
        // 參數（保留原始空白作解析）
        const rawNorm = toHalfWidth(rawText).trim();
        const arg = rawNorm.slice(6).trim(); // 去掉 "/stats"
        let dates = [];
        if (/^\d+$/.test(arg) && Number(arg) > 0) {
          dates = lastNDates(Math.min(Number(arg), 90)); // 上限 90 天
        } else if (/^\d{4}-\d{2}$/.test(arg)) {
          dates = monthDates(arg);
        } else {
          dates = lastNDates(7);
        }
      
        // 成員名單與每日完成
        const allMembers = await getAllMembers(chatId);
        const nameById = new Map(allMembers.map(m => [m.userId, m.displayName]));
        const totalMembers = nameById.size;
      
        const perDayDone = [];
        for (const d of dates) {
          const uids = await getDoneUids(chatId, d); // Set of userId 當天完成
          perDayDone.push({ date: d, set: new Set(uids) });
        }
      
        // 指標
        const counts = perDayDone.map(x => x.set.size);
        const avg = counts.length ? (counts.reduce((a,b)=>a+b,0)/counts.length) : 0;
      
        // 全勤 / 曾完成 / 皆未完成
        const allIds = [...nameById.keys()];
        const fullIds = allIds.filter(uid => perDayDone.every(x => x.set.has(uid)));
        const anyIds  = allIds.filter(uid => perDayDone.some(x => x.set.has(uid)));
        const noneIds = allIds.filter(uid => !anyIds.includes(uid));
      
        // 每位成員未完成天數與日期
        const perMemberLines = allIds.map(uid => {
          const name = nameById.get(uid) || uid;
          const missed = dates.filter(d => !perDayDone.find(x => x.date===d).set.has(uid));
          const dd = missed.join(", ");
          return `${name}：${missed.length}天${missed.length ? `（${dd}）` : ""}`;
        }).sort((a,b)=>a.localeCompare(b,"zh-Hant"));
      
        const rangeTitle = `${dates[0]} ~ ${dates[dates.length-1]}`;
        const title = `[${rangeTitle}] 定課統計`;
      
        // 彙整輸出（摘要 + 每日完成數 + 未全勤名單 + 各成員未完成明細）
        const linesSummary = [
          `總成員：${totalMembers}`,
          `每日平均完成：${avg.toFixed(1)}`,
          `全勤：${fullIds.length}`,
          `曾完成：${anyIds.length}`,
          `皆未完成：${noneIds.length}`,
          "",
          "每日完成數：",
          ...perDayDone.map(x => `${x.date}：${x.set.size}`),
          "",
          "未全勤名單：",
          ...fullIds.length === allIds.length ? ["（無）"] :
            allIds.filter(uid => !fullIds.includes(uid))
                  .map(uid => nameById.get(uid) || uid)
                  .sort((a,b)=>a.localeCompare(b,"zh-Hant")),
          "",
          "各成員未完成明細：",
          ...perMemberLines
        ];
      
        const blocks = chunk([title, ...linesSummary]);
        await reply(e.replyToken, { type:"text", text: blocks[0] });
        if (blocks.length > 1) await push(chatId, blocks.slice(1));
        return;
      }


      // ===== /? 指令一覽 =====
      if (isText && isCmd(cmd, ["/?","/help","/h"])) {
        const title = `指令一覽`;
        const lines = [
          "/reg [姓名]          登錄自己（未帶姓名則取 LINE 顯示名稱）",
          "/d                   今日完成定課",
          "/s                   今日完成/未完成清單（含統計）",
          "/a                   全部名單（已登錄者）",
          "/stats N             近 N 天統計（例：/stats 7）",
          "/stats YYYY-MM       指定月份統計（例：/stats 2025-08），含各成員未完成天數與日期",
          "/help             顯示此說明"
        ];
        const blocks = chunk([title, ...lines]);
        await reply(e.replyToken, { type:"text", text: blocks[0] });
        if (blocks.length>1) await push(chatId, blocks.slice(1));
        return;
      }


      // 其他訊息：不回覆
    }));
  } catch (err) {
    console.error(err);
  }
  return res.status(200).json({ ok:true });
}
