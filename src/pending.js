// Диалоговое состояние: бот запоминает, что ждёт от пользователя ответ.
// Без этого команда /set_gdrive без аргумента просила ссылку, а следующее
// сообщение со ссылкой молча игнорировалось (не начинается с "/").

const TTL = 10 * 60; // 10 минут на ответ

const KEY = (chatId, userId) => `pending:${chatId}:${userId}`;

export function setPending(chatId, userId, action, env, extra = {}) {
  return env.BOT_KV.put(
    KEY(chatId, userId),
    JSON.stringify({ action, ...extra, at: Date.now() }),
    { expirationTtl: TTL }
  );
}

export function getPending(chatId, userId, env) {
  return env.BOT_KV.get(KEY(chatId, userId), "json");
}

export function clearPending(chatId, userId, env) {
  return env.BOT_KV.delete(KEY(chatId, userId));
}
