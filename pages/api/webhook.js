// pages/api/webhook.js
import getRawBody from "raw-body";
import crypto from "crypto";
export const config = { api: { bodyParser: false } };

const SECRET = process.env.LINE_CHANNEL_SECRET;
const TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN;

function validSig(raw, sig) {
  const mac = crypto.createHmac("sha256", SECRET).update(raw).digest("base64");
  return mac === sig;
}
async function call(endpoint, init={}) {
  return fetch(`https://api.line.me${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers||{})
    }
  });
}
async function reply(replyToken, messages) {
  const payload = Array.isArray(messages) ? { replyToken, messages } : { replyToken, messages:[messages] };
  await call("/v2/bot/message/reply", { method:"POST", body: JSON.stringify(payload) });
}
async function push(to, texts) {
  if (!texts.length) return;
  await call("/v2/bot/message/push", { method:"POST",
    body: JSON.stringify({ to, messages: texts.map(t=>({ type:"text", text:t })) })
  });
}
async function listIds(srcType, chatId) {
  const base = srcType === "group" ? `/v2/bot/group/${chatId}` : `/v2/bot/room/${chatId}`;
  const all=[]; let start="";
  while (true) {
    const url = `${base}/members/ids${start?`?start=${encodeURIComponent(start)}`:""}`;
    const r = await call(url, { method:"GET", headers:{ "Content-Type":undefined } });
    if (!r.ok) throw new Error(`members/ids ${r.status}`);
    const j = await r.json(); all.push(...(j.memberIds||[]));
    if (!j.next) break; start = j.next;
  }
  return all;
}
async function displayName(srcType, chatId, userId) {
  const base = srcType === "group" ? `/v2/bot/group/${chatId}` : `/v2/bot/room/${chatId}`;
  const r = await call(`${base}/member/${userId}`, { method:"GET", headers:{ "Content-Type":undefined } });
  if (!r.ok) return null;
  const j = await r.json(); return j.displayName || null;
}
function chunk(lines, limit=4500) {
  const out=[]; let buf="";
  for (const line of lines) {
    const add=(buf?"\n":"")+line;
    if ((buf+add).length>limit) { if (buf) out.push(buf); buf=line; } else { buf+=add; }
  }
  if (buf) out.push(buf); return out;
}

export default async function handler(req, res) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return res.status(200).send("ok");
  if (req.method !== "POST") return res.status(405).end();

  let raw; try { raw = await getRawBody(req); } catch { return res.status(400).end("Bad Request"); }
  const sig = req.headers["x-line-signature"] || "";
  if (!validSig(raw, sig)) return res.status(403).end("Forbidden");

  let body; try { body = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).end("Bad Request"); }

  try {
    await Promise.all((body.events||[]).map(async (e)=>{
      console.log("event", e.type, "source=", e.source?.type, "gid=", e.source?.groupId, "rid=", e.source?.roomId, "text=", e.message?.text);
      if (e.type !== "message") return;

      const srcType = e.source?.type;                  // user | group | room
      const chatId  = e.source?.groupId || e.source?.roomId || e.source?.userId;
      const isText  = e.message?.type === "text";
      const text    = isText ? (e.message.text||"").trim() : "";

      // === /s：只在 group/room 執行，且不要先回 bot online（避免 replyToken 重複使用）===
      if (isText && (srcType==="group" || srcType==="room") && text === "/s") {
        const ids = await listIds(srcType, chatId);
        const names = [];
        for (const uid of ids) names.push((await displayName(srcType, chatId, uid)) || uid);

        const chunks = chunk(names);
        if (!chunks.length) return await reply(e.replyToken, { type:"text", text:"沒有成員資料可顯示。" });
        await reply(e.replyToken, { type:"text", text:chunks[0] });
        if (chunks.length > 1) await push(chatId, chunks.slice(1));
        return; // 結束，避免再回其他訊息
      }

      // 其他文字：健康回覆
      if (isText) await reply(e.replyToken, { type:"text", text:"bot online" });
    }));
  } catch (err) {
    console.error(err);
  }
  return res.status(200).json({ ok:true });
}
