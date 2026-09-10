// Ограничение тяжёлых /test: одновременно выполняется только один тест в чате.
// Нужен KV-lock, потому что кнопки /test могут нажать несколько человек подряд,
// и каждый тест тратит запросы к генераторам картинок/текста.

const DEFAULT_TTL = 3 * 60; // если воркер упал/таймаутнулся, замок сам исчезнет

function ttl(env) {
  const n = Number(env?.TEST_LOCK_TTL_SEC);
  return Number.isFinite(n) && n > 10 ? Math.min(n, 15 * 60) : DEFAULT_TTL;
}

function key(env, chatId) {
  // По умолчанию ограничение действует отдельно на каждый чат.
  // Если понадобится снова сделать один общий тест на всего бота:
  // TEST_LOCK_SCOPE=global.
  return String(env?.TEST_LOCK_SCOPE || "chat") === "global"
    ? "test:lock:global"
    : `test:lock:${chatId}`;
}

export async function acquireTestLock(env, chatId, userId) {
  if (!env?.BOT_KV) return { ok: true, lock: null };

  const k = key(env, chatId);
  const existing = await env.BOT_KV.get(k, "json").catch(() => null);
  if (existing?.id) return { ok: false, existing };

  const lock = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    chatId: String(chatId),
    userId: String(userId || ""),
    at: Date.now(),
  };

  await env.BOT_KV.put(k, JSON.stringify(lock), { expirationTtl: ttl(env) });
  return { ok: true, lock, key: k };
}

export async function releaseTestLock(env, acquired) {
  if (!env?.BOT_KV || !acquired?.key || !acquired?.lock?.id) return;

  try {
    const current = await env.BOT_KV.get(acquired.key, "json");
    if (current?.id === acquired.lock.id) await env.BOT_KV.delete(acquired.key);
  } catch {
    // lock не должен ломать основной сценарий
  }
}

export async function clearTestLockForChat(env, chatId) {
  if (!env?.BOT_KV) return;
  await env.BOT_KV.delete(`test:lock:${chatId}`);
  // На случай если раньше был включён глобальный lock.
  await env.BOT_KV.delete("test:lock:global");
}
