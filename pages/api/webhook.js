import getRawBody from "raw-body";
import crypto from "crypto";

export const config = { api: { bodyParser: false } };

// LINE env
const SECRET = process.env.LINE_CHANNEL_SECRET;
const TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// 可選：Upstash Redis（建議）
// 在 Vercel 設下：UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

// ===== 簽章驗證 =====
function validSig(raw, sig) {
  const mac = crypto.createHmac("sha256", SECRET).update(raw).digest("base64");
  return mac === sig;
}

// ===== LINE API 呼叫 =====
async function call(endpoint, init = {}) {
  return fetch(`https://api.line.me${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}
async function reply(replyToken, messages) {
  const payload = Array.isArray(messages) ? { replyToken, messages } : { replyToken, messages: [messages] };
  await call("/v2/bot/message/reply", { method: "POST", body: JSON.stringify(payload) });
}
async function push(to, texts) {
  if (!texts.length) return;
  await call("/v2/bot/message/push", {
    method: "POST",
    body: JSON.stringify({ to, messages: texts.map(t => ({ type: "text", text: t })) }),
  });
}
async function getProfile(srcType, chatId, userId) {
  const base = srcType === "group" ? `/v2/bot/group/${chatId}` : `/v2/bot/room/${chatId}`;
  const r = await call(`${base}/member/${userId}`, { method: "GET", headers: { "Content-Type": undefined } });
  if (!r.ok) return null;
  const j = await r.json();
  return { userId, displayName: j.displayName || userId };
}

// ===== 名單儲存層：Redis（優先）或記憶體 =====
const mem = new Map(); // chatId -> Map<userId, name>

async function redisCmd(command) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error("no-redis");
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
  if (!r.ok) throw new Error(`redis ${r.status}`);
  return r.json(); // { result, error? }
}
function keyOf(chatId) { return `group:${chatId}:members`; }

// 儲存或更新成員名稱
async function saveMember(chatId, userId, name) {
  try {
    await redisCmd(["HSET", keyOf(chatId), userId, name]);
  } catch {
    let m = mem.get(chatId); if (!m) { m = new Map(); mem.set(chatId, m); }
    m.set(userId, name);
  }
}
// 移除成員
async function removeMember(chatId, userId) {
  try { await redisCmd(["HDEL", keyOf(chatId), userId]); }
  catch {
    const m = mem.get(chatId); if (m) m.delete(userId);
  }
}
// 讀取全部成員（物件陣列）
async function getAllMembers(chatId) {
  try {
    const j = await redisCmd(["HGETALL", keyOf(chatId)]);
    const arr = j.result || []; // [field,value,field,value,...]
    const out = [];
    for (let i = 0; i < arr.length; i += 2) out.push({ userId: arr[i], displayName: arr[i + 1] });
    return out;
  } catch {
    const m = mem.get(chatId) || new Map();
    return Array.from(m, ([userId, displayName]) => ({ userId, displayName }));
  }
}

// ===== 文字分段（避免 5000 字上限） =====
function chunk(lines, limit = 4500) {
  const out = []; let buf = "";
  for (const line of lines) {
    const add = (buf ? "\n" : "") + line;
    if ((buf + add).length > limit) { if (buf) out.push(buf); buf = line; } else buf += add;
  }
  if (buf) out.push(buf);
  return out;
}

// ===== 主處理器 =====
export default async function handler(req, res) {
  // 健康檢查與 Verify
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return res.status(200).send("ok");
  if (req.method !== "POST") return res.status(405).end();

  let raw; try { raw = await getRawBody(req); } catch { return res.status(400).end("Bad Request"); }
  const sig = req.headers["x-line-signature"] || "";
  if (!validSig(raw, sig)) return res.status(403).end("Forbidden");

  let body; try { body = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).end("Bad Request"); }

  try {
    await Promise.all((body.events || []).map(async (e) => {
      const type = e.type;
      const srcType = e.source?.type; // user | group | room
      const chatId = e.source?.groupId || e.source?.roomId;
      const isText = type === "message" && e.message?.type === "text";
      const text = isText ? (e.message.text || "").trim() : "";

      // 只處理 group/room；私聊不記錄名單
      if (srcType !== "group" && srcType !== "room") {
        if (isText && text === "/s") await reply(e.replyToken, { type: "text", text: "請在群組使用 /s。" });
        return;
      }

      // 有人發言 → 抓他的 displayName 並登錄
      if (isText && e.source?.userId) {
        const prof = await getProfile(srcType, chatId, e.source.userId);
        if (prof) await saveMember(chatId, prof.userId, prof.displayName);
      }

      // 成員加入事件 → 批次登錄
      if (type === "memberJoined" && Array.isArray(e.joined?.members)) {
        for (const m of e.joined.members) {
          if (!m.userId) continue;
          const prof = await getProfile(srcType, chatId, m.userId);
          if (prof) await saveMember(chatId, prof.userId, prof.displayName);
        }
        // 可回覆歡迎詞（選用）
      }

      // 成員離開事件 → 從名單移除
      if (type === "memberLeft" && Array.isArray(e.left?.members)) {
        for (const m of e.left.members) if (m.userId) await removeMember(chatId, m.userId);
      }

      // 指令：/reg 手動登錄自己
      if (isText && text === "/reg" && e.source?.userId) {
        const prof = await getProfile(srcType, chatId, e.source.userId);
        if (prof) { await saveMember(chatId, prof.userId, prof.displayName); await reply(e.replyToken, { type: "text", text: "已登錄。" }); }
        else { await reply(e.replyToken, { type: "text", text: "無法取得你的資料。" }); }
        return;
      }

      // 指令：/s 列出目前已蒐集到的名單
      if (isText && text === "/s") {
        try {
          const members = await getAllMembers(chatId);
          if (!members.length) {
            await reply(e.replyToken, { type: "text", text: "名單尚空。請成員任意發言或輸入 /reg 完成登錄。" });
            return;
          }
          // 依顯示名稱排序
          const names = members.map(m => m.displayName).sort((a, b) => a.localeCompare(b, "zh-Hant"));
          const blocks = chunk(names);
          await reply(e.replyToken, { type: "text", text: blocks[0] });
          if (blocks.length > 1) await push(chatId, blocks.slice(1));
        } catch (err) {
          await reply(e.replyToken, { type: "text", text: "名單讀取失敗。" });
        }
        return;
      }

      // 其他訊息：可選擇不回覆；若要健康回覆，解除下行註解
      // if (isText) await reply(e.replyToken, { type: "text", text: "bot online" });
    }));
  } catch (err) {
    console.error(err);
  }

  return res.status(200).json({ ok: true });
}
