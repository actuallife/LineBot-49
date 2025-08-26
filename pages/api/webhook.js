// pages/api/webhook.js
import getRawBody from "raw-body";
import crypto from "crypto";
export const config = { api: { bodyParser: false } };

// ===== Env =====
const SECRET = process.env.LINE_CHANNEL_SECRET;
const TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

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
  return `${y}-${m}-${da}`; // YYYY-MM-DD
}
function chunk(lines, limit = 4500) {
  const out=[]; let buf="";
  for (const line of lines) { const add=(buf?"\n":"")+line; if ((buf+add).length>limit){ if(buf) out.push(buf); buf=line; } else buf+=add; }
  if (buf) out.push(buf); return out;
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

// ===== Storage: Redis (preferred) or in-memory =====
const mem = { members:new Map(), done:new Map() }; // members: chatId->Map<uid,name>; done: chatId->Map<date,Set<uid>>
async function redisExec(command) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error("no-redis");
  const r = await fetch(REDIS_URL, {
    method:"POST", headers:{ Authorization:`Bearer ${REDIS_TOKEN}`, "Content-Type":"application/json" },
    body: JSON.stringify({ command })
  });
  if (!r.ok) throw new Error(`redis ${r.status}`);
  return r.json(); // {result}
}
const keyMembers = (chatId)=>`group:${chatId}:members`;      // HASH uid->name
const keyDone    = (chatId,date)=>`group:${chatId}:done:${date}`; // SET of uid

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
      const text    = isText ? (e.message.text||"").trim() : "";

      if (srcType!=="group" && srcType!=="room") {
        if (isText && (text==="/d" || text==="/s")) await reply(e.replyToken,{type:"text",text:"請在群組使用指令。"});
        return;
      }

      // 每次發話/加入都嘗試登錄名稱
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
      if (type==="memberLeft" && Array.isArray(e.left?.members)) {
        // 可選：不強制刪除，保留名單以便統計
      }

      // ===== /reg 登錄自己 =====
      if (isText && text==="/reg" && uid) {
        const p = await getProfile(srcType, chatId, uid).catch(()=>null);
        if (p) { await saveMember(chatId, p.userId, p.displayName); await reply(e.replyToken,{type:"text",text:"已登錄。"}); }
        else { await reply(e.replyToken,{type:"text",text:"無法取得你的資料。"}); }
        return;
      }

      // ===== /d 今日完成 =====
      if (isText && text==="/d" && uid) {
        const date = todayKey();
        const p = await getProfile(srcType, chatId, uid).catch(()=>null);
        if (p) await saveMember(chatId, p.userId, p.displayName);
        await markDone(chatId, date, uid);
        await reply(e.replyToken, { type:"text", text:`已記錄：${date}` });
        return;
      }

      // ===== /s 狀態清單 =====
      if (isText && text==="/s") {
        const date = todayKey();
        const [all, doneUids, totalCnt] = await Promise.all([
          getAllMembers(chatId),
          getDoneUids(chatId, date),
          membersCount(srcType, chatId)
        ]);
        const nameById = new Map(all.map(m=>[m.userId, m.displayName]));
        const done = []; const undone = [];
        // 以已知名單為基準
        for (const [id, name] of nameById.entries()) {
          (doneUids.includes(id) ? done : undone).push(name || id);
        }
        done.sort((a,b)=>a.localeCompare(b,"zh-Hant"));
        undone.sort((a,b)=>a.localeCompare(b,"zh-Hant"));

        const title = `[${date}] 定課狀態：已完成 ${done.length}/${totalCnt ?? (done.length+undone.length)}`;
        const blocks = [];
        blocks.push(`${title}\n— 已完成（${done.length}）\n${done.length?done.join("\n"):"（無）"}`);
        blocks.push(`— 未完成（${undone.length}）\n${undone.length?undone.join("\n"):"（無）"}`);

        const parts = [];
        for (const b of blocks) parts.push(...chunk(b.split("\n")));

        await reply(e.replyToken, { type:"text", text: parts[0] });
        if (parts.length>1) await push(chatId, parts.slice(1));
        return;
      }
      // ===== /a 全部名單 =====
      if (isText && text === "/a") {
        const all   = await getAllMembers(chatId);
        const names = all.map(m => m.displayName).sort((a,b)=>a.localeCompare(b,"zh-Hant"));
      
        const title = `[${todayKey()}] 全部名單（${names.length}人）`;
        const blocks = chunk([title, ...names]);  // ← 不要 join("\n")
      
        await reply(e.replyToken, { type: "text", text: blocks[0] });
        if (blocks.length > 1) await push(chatId, blocks.slice(1));
        return;
      }
      // ===== /? 指令一覽 =====
      if (isText && text === "/?") {
        const title = `[${todayKey()}] 指令一覽`;
        const lines = [
          "/reg  登錄自己",
          "/d    今日完成定課",
          "/s    今日完成/未完成清單（含統計）",
          "/a    全部名單（已登錄者）",
          "/?    顯示此說明"
        ];
        const blocks = chunk([title, ...lines]); // 傳「行陣列」給 chunk
        await reply(e.replyToken, {
          type: "text",
          text: blocks[0],
          quickReply: {
            items: [
              { type:"action", action:{ type:"message", label:"/d",  text:"/d" } },
              { type:"action", action:{ type:"message", label:"/s",  text:"/s" } },
              { type:"action", action:{ type:"message", label:"/a",  text:"/a" } },
              { type:"action", action:{ type:"message", label:"/reg",text:"/reg" } }
            ]
          }
        });
        if (blocks.length > 1) await push(chatId, blocks.slice(1));
        return;
      }



      // 其他訊息：不回覆
    }));
  } catch (err) {
    console.error(err);
  }
  return res.status(200).json({ ok:true });
}
