// pages/api/webhook.js
import getRawBody from "raw-body";
import crypto from "crypto";

export const config = { api: { bodyParser: false } };

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const ACCESS_TOKEN   = process.env.LINE_CHANNEL_ACCESS_TOKEN;

function isValidSignature(raw, signature) {
  const mac = crypto.createHmac("sha256", CHANNEL_SECRET).update(raw).digest("base64");
  return mac === signature;
}

async function replyMessage(replyToken, messages) {
  const payload = Array.isArray(messages) ? { replyToken, messages } : { replyToken, messages: [messages] };
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

async function pushMessages(to, texts) {
  if (!texts.length) return;
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      to,
      messages: texts.map(t => ({ type: "text", text: t }))
    })
  });
}

async function fetchAllMemberIds(groupId) {
  const ids = [];
  let start = "";
  while (true) {
    const url = new URL(`https://api.line.me/v2/bot/group/${groupId}/members/ids`);
    if (start) url.searchParams.set("start", start);
    const r = await fetch(url, { headers: { "Authorization": `Bearer ${ACCESS_TOKEN}` } });
    if (!r.ok) throw new Error(`members/ids ${r.status}`);
    const data = await r.json();
    ids.push(...(data.memberIds || []));
    if (!data.next) break;
    start = data.next;
  }
  return ids;
}

async function fetchDisplayName(groupId, userId) {
  const r = await fetch(`https://api.line.me/v2/bot/group/${groupId}/member/${userId}`, {
    headers: { "Authorization": `Bearer ${ACCESS_TOKEN}` }
  });
  if (!r.ok) return null;
  const p = await r.json();
  return p.displayName || null;
}

function chunkByLimit(lines, limit = 4500) {
  const chunks = [];
  let buf = "";
  for (const line of lines) {
    const add = (buf ? "\n" : "") + line;
    if ((buf + add).length > limit) {
      if (buf) chunks.push(buf);
      buf = line;
    } else {
      buf += add;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

export default async function handler(req, res) {
  // 讓 LINE Console 的 Verify/瀏覽器健康檢查通過
  if (req.method === "GET") return res.status(200).send("ok");
  if (req.method !== "POST") return res.status(405).end();

  let raw;
  try {
    raw = await getRawBody(req);
  } catch {
    return res.status(400).end("Bad Request");
  }

  const signature = req.headers["x-line-signature"] || "";
  if (!isValidSignature(raw, signature)) return res.status(403).end("Forbidden");

  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).end("Bad Request");
  }

  try {
    await Promise.all((body.events || []).map(async (e) => {
      if (e.type !== "message" || e.source?.type !== "group") return;

      const groupId = e.source.groupId;
      const text = e.message?.type === "text" ? (e.message.text || "").trim() : "";

      if (text === "/s") {
        const memberIds = await fetchAllMemberIds(groupId);

        const names = [];
        for (const uid of memberIds) {
          const name = await fetchDisplayName(groupId, uid);
          names.push(name || uid);
        }

        const chunks = chunkByLimit(names);
        if (!chunks.length) {
          await replyMessage(e.replyToken, { type: "text", text: "沒有成員資料可顯示。" });
        } else {
          await replyMessage(e.replyToken, { type: "text", text: chunks[0] });
          if (chunks.length > 1) await pushMessages(groupId, chunks.slice(1));
        }
      }
    }));
  } catch (err) {
    console.error(err);
    // 仍回 200，避免 LINE 過度重送
  }

  res.status(200).json({ ok: true });
}
