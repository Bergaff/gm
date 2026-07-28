// Права внутри чата.
//
// Уровни:
//   owner   — ADMIN_IDS из config.js, видит статистику по всем чатам
//   admin   — администратор Telegram-чата, полные права в своём чате
//   granted — участник, которому админ выдал права через /grant
//   user    — обычный участник, только просмотр

import { isAdmin } from "./config.js";
import { isChatAdmin } from "./telegram.js";
import { getSettings, patchSettings } from "./storage.js";

export async function getRole(chatId, userId, env, options = {}) {
  const { isChannelPost = false } = options;

  if (isAdmin(userId)) return "owner";

  // В канале у сообщения нет автора — проверять некого.
  if (isChannelPost || !userId) return "user";

  // Личка с ботом: пользователь сам себе админ.
  if (String(chatId) === String(userId)) return "admin";

  if (await isChatAdmin(chatId, userId, env)) return "admin";

  const settings = await getSettings(chatId, env);
  const granted = settings.grantedUsers || {};
  if (granted[String(userId)]) return "granted";

  return "user";
}

// Может менять настройки чата
export function canEdit(role) {
  return role === "owner" || role === "admin" || role === "granted";
}

// Может выдавать/забирать права другим (granted — не может)
export function canGrant(role) {
  return role === "owner" || role === "admin";
}

export async function grantUser(chatId, userId, username, env) {
  const settings = await getSettings(chatId, env);
  const granted = { ...(settings.grantedUsers || {}) };

  granted[String(userId)] = {
    username: username || null,
    at: new Date().toISOString(),
  };

  await patchSettings(chatId, { grantedUsers: granted }, env);
  return granted;
}

export async function revokeUser(chatId, userId, env) {
  const settings = await getSettings(chatId, env);
  const granted = { ...(settings.grantedUsers || {}) };

  const existed = Boolean(granted[String(userId)]);
  delete granted[String(userId)];

  await patchSettings(chatId, { grantedUsers: granted }, env);
  return existed;
}

export async function listGranted(chatId, env) {
  const settings = await getSettings(chatId, env);
  return Object.entries(settings.grantedUsers || {});
}
