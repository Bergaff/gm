// Очередь тестовых генераций /test.
//
// Почему не сразу в обработчике кнопки: webhook отвечает Telegram мгновенно,
// а тяжёлая работа продолжается в waitUntil, где у воркера короткий запас
// времени. Цепочка «подпись -> перевод -> очередь моделей» туда не влезала:
// воркер умирал, и сообщение навсегда оставалось «⏳ Тестирую...».
// Поэтому кнопка только ставит задание в KV, а выполняет его ежеминутный
// cron (scheduled) — у него времени достаточно, результат приходит
// в течение минуты правкой того же статусного сообщения.

const JOB_TTL = 10 * 60; // секунд; старше — считаем зависшим и выбрасываем
const key = (chatId) => `testjob:${chatId}`;

export async function queueTestJob(env, job) {
  if (!env?.BOT_KV) return { ok: false, reason: "no_kv" };
  const k = key(job.chatId);
  const existing = await env.BOT_KV.get(k, "json").catch(() => null);
  if (existing && Date.now() - Number(existing.createdAt || 0) < JOB_TTL * 1000) {
    return { ok: false, existing };
  }
  const record = { ...job, chatId: String(job.chatId), createdAt: Date.now() };
  await env.BOT_KV.put(k, JSON.stringify(record), { expirationTtl: JOB_TTL });
  return { ok: true, job: record };
}

export async function listTestJobs(env) {
  if (!env?.BOT_KV) return [];
  const jobs = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const res = await env.BOT_KV.list({ prefix: "testjob:", cursor });
    for (const k of res.keys || []) {
      const job = await env.BOT_KV.get(k.name, "json").catch(() => null);
      if (job?.chatId) jobs.push(job);
    }
    if (res.list_complete || !res.cursor) break;
    cursor = res.cursor;
  }
  return jobs;
}

export function deleteTestJob(env, chatId) {
  if (!env?.BOT_KV) return Promise.resolve();
  return env.BOT_KV.delete(key(chatId));
}

export function clearTestJobForChat(chatId, env) {
  return deleteTestJob(env, chatId);
}

export const TEST_JOB_TTL_MS = JOB_TTL * 1000;
