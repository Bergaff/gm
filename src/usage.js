// Учёт расхода Cloudflare Workers AI в нейронах.
//
// Cloudflare не даёт API «сколько осталось» — только дашборд и GraphQL
// (последний требует отдельный токен с правами на аналитику и отдаёт
// данные с задержкой). Поэтому считаем сами: у каждой модели известный
// тариф, при каждом вызове прибавляем.
//
// Тарифы: https://developers.cloudflare.com/workers-ai/platform/pricing/

export const FREE_NEURONS_PER_DAY = 10000;

// Ключ по дате UTC — лимит сбрасывается в 00:00 UTC
function dayKey(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `neurons:${d.toISOString().slice(0, 10)}`;
}

/**
 * Стоимость генерации картинки.
 * flux-1-schnell: 4.80 нейрона за тайл 512x512 + 9.60 за шаг.
 * Картинка 1024x1024 = 4 тайла.
 */
export function estimateImageNeurons(model, opts = {}) {
  const { width = 1024, height = 1024, steps = 4 } = opts;
  const tiles = Math.max(1, Math.ceil(width / 512) * Math.ceil(height / 512));

  if (String(model).includes("flux-1-schnell")) {
    return tiles * 4.8 + steps * 9.6;
  }
  if (String(model).includes("lucid-origin")) {
    return tiles * 636 + steps * 12;
  }
  if (String(model).includes("phoenix")) {
    return tiles * 530 + steps * 10;
  }
  // SDXL-lightning, dreamshaper и прочие — средняя оценка
  return tiles * 20 + steps * 10;
}

/**
 * Стоимость генерации текста.
 * llama-3.1-8b: 25608 нейронов на миллион входных токенов,
 * 75147 на миллион выходных. Токены оцениваем по длине текста.
 */
export function estimateTextNeurons(inputChars, outputChars) {
  const inTok = Math.ceil(inputChars / 3.5);
  const outTok = Math.ceil(outputChars / 3.5);
  return (inTok / 1e6) * 25608 + (outTok / 1e6) * 75147;
}

// Прибавить расход за сегодня. Никогда не бросает исключение.
export async function addUsage(env, neurons, kind = "other") {
  // ВАЖНО: neurons может быть 0 — у Gemini и NVIDIA свои лимиты,
  // и мы считаем их запросы, а не нейроны. Раньше нулевой расход
  // отсекался этой проверкой, и счётчики оставались пустыми.
  if (!env?.BOT_KV) return;
  if (!neurons && kind !== "gemini" && kind !== "nvidia") return;
  if (neurons < 0) return;

  try {
    const key = dayKey();
    const cur = (await env.BOT_KV.get(key, "json")) ||
      { total: 0, image: 0, text: 0, calls: 0, gemini: 0, nvidia: 0 };

    cur.total += neurons;
    cur.calls += 1;

    // Cloudflare тратит нейроны, у Gemini и NVIDIA свои лимиты —
    // их считаем в запросах, а не в нейронах.
    if (kind === "image") cur.image += neurons;
    else if (kind === "text") cur.text += neurons;
    else if (kind === "gemini") cur.gemini = (cur.gemini || 0) + 1;
    else if (kind === "nvidia") cur.nvidia = (cur.nvidia || 0) + 1;

    // Держим 8 дней, чтобы показывать историю за неделю
    await env.BOT_KV.put(key, JSON.stringify(cur), { expirationTtl: 8 * 86400 });
  } catch {
    // учёт не должен ломать генерацию
  }
}

export async function getUsage(env, offsetDays = 0) {
  try {
    const data = await env.BOT_KV.get(dayKey(offsetDays), "json");
    return data || { total: 0, image: 0, text: 0, calls: 0, gemini: 0, nvidia: 0 };
  } catch {
    return { total: 0, image: 0, text: 0, calls: 0, gemini: 0, nvidia: 0 };
  }
}

// Сводка за последние N дней
export async function getUsageHistory(env, days = 7) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    out.push({
      date: d.toISOString().slice(5, 10),
      ...(await getUsage(env, -i)),
    });
  }
  return out;
}

// Сколько времени до сброса лимита (00:00 UTC)
export function timeUntilReset() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  const ms = next - now;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return { hours: h, minutes: m };
}

function bar(percent, width = 20) {
  const filled = Math.min(width, Math.max(0, Math.round((percent / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * Текст для команды /usage.
 * Показывает расход за сегодня, остаток и историю.
 */
export async function usageText(env, escapeHtml) {
  if (!env.AI) {
    return (
      "⚠️ <b>Workers AI не подключён</b>\n\n" +
      "Добавьте в <code>wrangler.toml</code>:\n" +
      "<code>[ai]\nbinding = \"AI\"</code>"
    );
  }

  const today = await getUsage(env);
  const used = Math.round(today.total);
  const left = Math.max(0, FREE_NEURONS_PER_DAY - used);
  const percent = Math.min(100, (used / FREE_NEURONS_PER_DAY) * 100);
  const reset = timeUntilReset();

  // Сколько ещё постов влезет: картинка FLUX + подпись ≈ 72 нейрона
  const perPost = 72;
  const postsLeft = Math.floor(left / perPost);

  const lines = [
    "⚡ <b>Расход Cloudflare Workers AI</b>",
    "",
    `<code>${bar(percent)}</code> ${percent.toFixed(1)}%`,
    "",
    `Потрачено: <b>${used}</b> из ${FREE_NEURONS_PER_DAY} нейронов`,
    `Осталось: <b>${left}</b>`,
    `Сброс через: <b>${reset.hours} ч ${reset.minutes} мин</b> (00:00 UTC)`,
    "",
    `Хватит ещё примерно на <b>${postsLeft}</b> постов`,
    "",
    "<b>Cloudflare сегодня</b>",
    `🖼 картинки: ${Math.round(today.image)} нейронов`,
    `💬 текст: ${Math.round(today.text)} нейронов`,
    `📞 вызовов: ${today.calls}`,
    "",
    "<b>Другие провайдеры</b>",
    `🍌 Gemini: ${today.gemini || 0} картинок` +
      (today.gemini ? " (свой лимит ~500/сутки)" : ""),
    `🟢 NVIDIA: ${today.nvidia || 0} картинок` +
      (today.nvidia ? " (расход кредитов)" : ""),
  ];

  const history = await getUsageHistory(env, 7);
  const past = history.slice(1).filter((d) => d.total > 0);

  if (past.length) {
    lines.push("", "<b>Предыдущие дни</b>");
    for (const d of past) {
      const p = Math.min(100, (d.total / FREE_NEURONS_PER_DAY) * 100);
      lines.push(`${d.date}: ${Math.round(d.total)} (${p.toFixed(0)}%)`);
    }
  }

  lines.push(
    "",
    "<i>Подсчёт локальный: Cloudflare не отдаёт остаток через API.</i>",
    "<i>Точные цифры — в дашборде Workers AI.</i>"
  );

  if (percent >= 90) {
    lines.push("", "🔴 <b>Лимит почти исчерпан</b> — бот перейдёт на NVIDIA.");
  } else if (percent >= 70) {
    lines.push("", "🟡 Израсходовано больше 70%.");
  }

  return lines.join("\n");
}
