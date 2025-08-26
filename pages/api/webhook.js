// pages/api/webhook.js
import getRawBody from "raw-body";
import crypto from "crypto";
export const config = { api: { bodyParser: false } };

/* ========= 環境變數 ========= */
const SECRET = process.env.LINE_CHANNEL_SECRET;
const TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

/* ========= 指令正規化 ========= */
function toHalfWidth(s) {
  return String(s || "")
    .replace(/\u3000/g, " ")
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}
function normCmd(s) { return toHalfWidth(s).trim().toLowerCase(); }
function isCmd(cmd, list) { return list.includes(cmd); }

/* ========= 共用工具 ========= */
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
function chunk(lines, limit = 4500) {
  const out=[]; let buf="";
  for (const line of lines) {
    const add=(buf?"\n":"")+line;
    if ((buf+add).length>limit) { if(buf) out.push(buf); buf=line; } else buf+=add;
  }
  if (buf) out.push(buf); return out;
}

/* ========= LINE API ========= */
async function callPOST(endpoint, bodyObj) {
  return fetch(`https://api.line.me${endpoint}`, {
    method: "POST",
    headers: { Authorization:`Bearer ${TOKEN}`, "Content-Type":"application/json" },
    body: JSON.stringify(bodyObj)
  });
}
async function callGET(endpoint) {
  return fetch(`https://api.line.me${endpoint}`, {
    headers: { Authorization:`Bearer ${TOKEN}` }
  });
}
async function reply(replyToken, messages) {
  const payload = Array.isArray(messages) ? { replyToken, messages } : { replyToken, messages:[messages] };
  await callPOST("/v2/bot/message/reply", payload);
}
async function push(to, texts) {
  if (!texts.length) return;
  await callPOST("/v2/bot/message/push", { to, messages: texts.map(t=>({type:"text", text:t})) });
}
async function getProfile(srcType, chatId, userId) {
  const base = srcType==="group" ? `/v2/bot/group/${chatId}` : `/v2/bot/room/${chatId}`;
  const r = await callGET(`${base}/member/${userId}`);
  if (!r.ok) return null;
  const j = await r.json();
  return { userId, displayName: j.displayName || userId };
}
async function membersCount(srcType, chatId) {
  const base = srcType==="group" ? `/v2/bot/group/${chatId}` : `/v2/bot/room/${chatId}`;
  const r = await callGET(`${base}/members/count`);
  if (!r.ok) return null;
  const j = await r.json();
  return j.count ?? null;
}

/* ========= Redis（必須） ========= */
async function redisExec(command) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error("Redis not configured");
  const r = await fetch(REDIS_URL, {
    method:"POST",
    headers:{ Authorization:`Bearer ${REDIS_TOKEN}`, "Content-Type":"application/json" },
    body: JSON.stringify({ command })
  });
  if (!r.ok) throw new Error(`redis ${r.status}`);
  return r.json();
}
const keyMembers = (chatId)=>`group:${chatId}:members`;             // HASH uid->name
const keyDone    = (chatId,date)=>`group:${chatId}:done:${date}`;   // SET of uid

async function saveMember(chatId, uid, name) {
  await redisExec(["HSET", keyMembers(chatId), uid, name]);
}
async function getAllMembers(chatId) {
  const j = await redisExec(["HGETALL", keyMembers(chatId)]);
  const arr = j.result || []; const out=[];
  for (let i=0;i<arr.length;i+=2) out.push({ userId:arr[i], displayName:arr[i+1] });
  return out;
}
async function markDone(chatId, dateKey, uid) {
  await redisExec(["SADD", keyDone(chatId,dateKey), uid]);
}
async function getDoneUids(chatId, dateKey) {
  const j = await redisExec(["SMEMBERS", keyDone(chatId,dateKey)]);
  return j.result || [];
}

/* ========= Handler ========= */
export default async function handler(req, res) {
  // 健康檢查 / Verify
  if (req.method==="GET" || req.method==="HEAD" || req.method==="OPTIONS") return res.status(200).send("ok");
  if (req.method!=="POST") return res.status(405).end();

  // 讀 raw + 驗簽
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
      const cmd     = normCmd(rawText);            // 指令比對（半形、小寫）
      const rawNorm = toHalfWidth(rawText).trim(); // 參數解析（保留大小寫與中文）
      const redisReady = !!(REDIS_URL && REDIS_TOKEN);

      if (srcType!=="group" && srcType!=="room") {
        if (isText && ([ "/d","/s","/a","/?","/help","/h","/stats" ].some(p=>cmd.startsWith(p)) || cmd.startsWith("/reg"))) {
          await reply(e.replyToken,{type:"text",text:"請在群組使用指令。"});
        }
        return;
      }

      // 未配置 Redis 時，所有指令直接提示
      async function guardRedis() {
        if (!redisReady) {
          await reply(e.replyToken,{type:"text",text:"尚未配置資料庫。請在 Vercel 設定 UPSTASH_REDIS_REST_URL / _TOKEN。"});
          return false;
        }
        return true;
      }

      // 發話或加入時，嘗試登錄顯示名稱（不阻擋失敗）
      if (uid && (isText || type==="memberJoined")) {
        const prof = await getProfile(srcType, chatId, uid).catch(()=>null);
        if (prof && redisReady) await saveMember(chatId, prof.userId, prof.displayName);
      }
      if (type==="memberJoined" && Array.isArray(e.joined?.members) && redisReady) {
        for (const m of e.joined.members) if (m.userId) {
          const p = await getProfile(srcType, chatId, m.userId).catch(()=>null);
          if (p) await saveMember(chatId, p.userId, p.displayName);
        }
      }

      /* ===== /reg [姓名] ===== */
      if (isText && (cmd === "/reg" || cmd.startsWith("/reg "))) {
        if (!await guardRedis()) return;
        if (!uid) return;
        let nameArg = rawNorm.slice(4).trim().replace(/\s+/g, " ").replace(/[\r\n]/g, "").slice(0, 50);
        let finalName = nameArg;
        if (!finalName) {
          const p = await getProfile(srcType, chatId, uid).catch(()=>null);
          finalName = p?.displayName || uid;
        }
        await saveMember(chatId, uid, finalName);
        await reply(e.replyToken,{ type:"text", text:`已登錄：${finalName}` });
        return;
      }

      /* ===== /d 今日完成 ===== */
      if (isText && isCmd(cmd, ["/d","d"])) {
        if (!await guardRedis()) return;
        if (uid) {
          const date = todayKey();
          const p = await getProfile(srcType, chatId, uid).catch(()=>null);
          if (p) await saveMember(chatId, p.userId, p.displayName);
          await markDone(chatId, date, uid);
          await reply(e.replyToken, { type:"text", text:`已記錄：${date}` });
        }
        return;
      }

      /* ===== /s 今日清單 ===== */
      if (isText && isCmd(cmd, ["/s","s"])) {
        if (!await guardRedis()) return;
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
        const lines = [
          title,
          `— 已完成（${done.length}）`,
          ...(done.length?done:["（無）"]),
          `— 未完成（${undone.length}）`,
          ...(undone.length?undone:["（無）"])
        ];
        const blocks = chunk(lines);
        await reply(e.replyToken, { type:"text", text: blocks[0] });
        if (blocks.length>1) await push(chatId, blocks.slice(1));
        return;
      }

      /* ===== /a 全部名單 ===== */
      if (isText && isCmd(cmd, ["/a","a"])) {
        if (!await guardRedis()) return;
        const all   = await getAllMembers(chatId);
        const names = all.map(m => m.displayName).sort((a,b)=>a.localeCompare(b,"zh-Hant"));
        const title = `已登錄名單（${names.length}人）`;
        const blocks = chunk([title, ...names]);
        await reply(e.replyToken, { type: "text", text: blocks[0] });
        if (blocks.length > 1) await push(chatId, blocks.slice(1));
        return;
      }

      /* ===== /stats N 或 /stats YYYY-MM ===== */
      if (isText && (cmd.startsWith("/stats") || cmd === "stats")) {
        if (!await guardRedis()) return;
        const arg = toHalfWidth(rawText).trim().slice(6).trim();
        let dates = [];
        if (/^\d+$/.test(arg) && Number(arg) > 0) dates = lastNDates(Math.min(Number(arg), 90));
        else if (/^\d{4}-\d{2}$/.test(arg))     dates = monthDates(arg);
        else                                     dates = lastNDates(7);

        const allMembers = await getAllMembers(chatId);
        const nameById = new Map(allMembers.map(m => [m.userId, m.displayName]));
        const totalMembers = nameById.size;

        const perDayDone = [];
        for (const d of dates) {
          const uids = await getDoneUids(chatId, d);
          perDayDone.push({ date: d, set: new Set(uids) });
        }

        const counts = perDayDone.map(x => x.set.size);
        const avg = counts.length ? (counts.reduce((a,b)=>a+b,0)/counts.length) : 0;

        const allIds = [...nameById.keys()];
        const fullIds = allIds.filter(uid => perDayDone.every(x => x.set.has(uid)));
        const anyIds  = allIds.filter(uid => perDayDone.some(x => x.set.has(uid)));
        const noneIds = allIds.filter(uid => !anyIds.includes(uid));

        // 各成員未完成天數與日期
        const perMemberLines = allIds.map(uid => {
          const name = nameById.get(uid) || uid;
          const missed = dates.filter(d => !perDayDone.find(x => x.date===d).set.has(uid));
          const dd = missed.join(", ");
          return `${name}：未完成 ${missed.length} 天${missed.length ? `（${dd}）` : ""}`;
        }).sort((a,b)=>a.localeCompare(b,"zh-Hant"));

        const rangeTitle = `${dates[0]} ~ ${dates[dates.length-1]}`;
        const title = `[${rangeTitle}] 定課統計`;

        const summary = [
          title,
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
          ...((fullIds.length === allIds.length) ? ["（無）"]
             : allIds.filter(uid => !fullIds.includes(uid))
                     .map(uid => nameById.get(uid) || uid)
                     .sort((a,b)=>a.localeCompare(b,"zh-Hant"))),
          "",
          "各成員未完成明細：",
          ...perMemberLines
        ];
        const blocks = chunk(summary);
        await reply(e.replyToken, { type:"text", text: blocks[0] });
        if (blocks.length>1) await push(chatId, blocks.slice(1));
        return;
      }

      /* ===== /? 指令一覽 ===== */
      if (isText && isCmd(cmd, ["/?","/help","/h"])) {
        const lines = [
          "指令一覽",
          "/reg [姓名]          登錄自己",
          "/d                   今日完成定課",
          "/s                   今日完成/未完成清單",
          "/a                   已登錄清單",
          "/stats N             近 N 天統計（例：/stats 7）",
          "/stats YYYY-MM       指定月份統計（例：/stats 2025-08），含各成員未完成天數與日期",
          "/help             顯示此說明"
        ];
        const blocks = chunk(lines);
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
