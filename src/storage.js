import { DEFAULT_SETTINGS } from "./config.js";

const KEY = (chatId) => `chat:${chatId}`;

export async function getSettings(chatId, env) {
  const saved = await env.BOT_KV.get(KEY(chatId), "json");
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

export async function saveSettings(chatId, settings, env) {
  await env.BOT_KV.put(KEY(chatId), JSON.stringify(settings));
}

export async function patchSettings(chatId, patch, env) {
  const current = await getSettings(chatId, env);
  const next = { ...current, ...patch };
  await saveSettings(chatId, next, env);
  return next;
}

export async function registerChat(chatId, chat, env) {
  const existing = await env.BOT_KV.get(KEY(chatId), "json");
  const title = chat.title || chat.username || String(chatId);

  if (existing) {
    if (existing.title !== title) {
      await saveSettings(chatId, { ...existing, title }, env);
    }
    return false;
  }

  await saveSettings(
    chatId,
    {
      ...DEFAULT_SETTINGS,
      title,
      type: chat.type,
      createdAt: new Date().toISOString(),
    },
    env
  );

  return true;
}

export function removeChat(chatId, env) {
  return env.BOT_KV.delete(KEY(chatId));
}

export async function listChats(env) {
  const chats = [];
  let cursor;

  do {
    const page = await env.BOT_KV.list({ prefix: "chat:", cursor });
    for (const key of page.keys) {
      chats.push(key.name.replace("chat:", ""));
    }
    cursor = page.cursor;
    if (page.list_complete) break;
  } while (cursor);

  return chats;
}
