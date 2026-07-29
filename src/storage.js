import { DEFAULT_SETTINGS } from "./config.js";

const KEY = (chatId) => `chat:${chatId}`;

// ВАЖНО: спред копирует только верхний уровень. Вложенные массивы и объекты
// (weekdayPrompts, grantedUsers) остались бы ОБЩЕЙ ссылкой на DEFAULT_SETTINGS,
// а модуль живёт в изоляте между запросами — правка в одном чате протекала бы
// во все остальные. Поэтому клонируем дефолты глубоко.
function freshDefaults() {
  return structuredClone(DEFAULT_SETTINGS);
}

export async function getSettings(chatId, env) {
  // ВАЖНО: KV.get(..., "json") бросает исключение на битой записи.
  // Раньше один повреждённый чат ронял ЛЮБУЮ команду, которая
  // перебирает все чаты (/chats, /change) — бот просто молчал.
  let saved = null;
  try {
    saved = await env.BOT_KV.get(KEY(chatId), "json");
  } catch {
    // запись повреждена — работаем на настройках по умолчанию
    saved = null;
  }
  return { ...freshDefaults(), ...(saved || {}) };
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
      ...freshDefaults(),
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
