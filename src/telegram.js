export async function tg(method, payload, env) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );

  const result = await response.json().catch(() => ({ ok: false }));

  if (!result.ok) {
    console.log(`TG ${method} error:`, JSON.stringify(result).slice(0, 500));
  }

  return result;
}

export function sendMessage(chatId, text, env, extra = {}) {
  return tg(
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    },
    env
  );
}

export function sendPhotoUrl(chatId, url, caption, env, extra = {}) {
  return tg(
    "sendPhoto",
    { chat_id: chatId, photo: url, caption, parse_mode: "HTML", ...extra },
    env
  );
}

export async function sendPhotoBytes(chatId, bytes, caption, env, extra = {}) {
  const form = new FormData();

  form.append("chat_id", String(chatId));
  form.append("caption", caption || "");
  form.append("parse_mode", "HTML");

  if (extra.reply_markup) {
    form.append("reply_markup", JSON.stringify(extra.reply_markup));
  }

  form.append("photo", new Blob([bytes], { type: "image/jpeg" }), "morning.jpg");

  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`,
    { method: "POST", body: form }
  );

  const result = await response.json().catch(() => ({ ok: false }));

  if (!result.ok) {
    console.log("TG sendPhoto(bytes) error:", JSON.stringify(result).slice(0, 500));
  }

  return result;
}

export function sendDocumentBytes(chatId, bytes, filename, caption, env) {
  const form = new FormData();

  form.append("chat_id", String(chatId));
  form.append("caption", caption || "");
  form.append("document", new Blob([bytes], { type: "text/csv" }), filename);

  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
  }).then((r) => r.json());
}

export function answerCallback(callbackId, text, env, alert = false) {
  return tg(
    "answerCallbackQuery",
    { callback_query_id: callbackId, text, show_alert: alert },
    env
  );
}

export function editMarkup(chatId, messageId, markup, env) {
  return tg(
    "editMessageReplyMarkup",
    { chat_id: chatId, message_id: messageId, reply_markup: markup },
    env
  );
}

export async function isChatAdmin(chatId, userId, env) {
  if (String(chatId) === String(userId)) return true;

  const result = await tg("getChatMember", { chat_id: chatId, user_id: userId }, env);

  return ["creator", "administrator"].includes(result.result?.status);
}

export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
