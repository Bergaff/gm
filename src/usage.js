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

function emptyUsage() {
  return {
    total: 0, image: 0, text: 0, calls: 0,
    gemini: 0, geminiText: 0, geminiImage: 0, nvidia: 0, openrouterImage: 0,
    // Фактические вызовы image-API по провайдерам за день:
    // { "deepinfra-p-image": { calls, ok, fails }, "cf-flux": {...} }
    api: {},
    // Отдельная сводка по платной генерации: сколько ушло в утреннюю
    // рассылку, сколько съели тесты по лимиту и тесты владельца.
    paidImage: {
      calls: 0, ok: 0, fails: 0,
      production: 0, limitedTests: 0, ownerTests: 0,
      costUsd: 0, testLimit: 3,
    },
  };
}

function normalizeUsage(data) {
  const base = emptyUsage();
  if (!data || typeof data !== "object") return base;
  return {
    ...base,
    ...data,
    api: data.api && typeof data.api === "object" ? data.api : {},
    paidImage: { ...base.paidImage, ...(data.paidImage || {}) },
  };
}

// Записать один фактический вызов image-API. Пишется из generateImage()
// в момент реального обращения к провайдеру: пропуски по cooldown и
// заблокированные лимитом тесты сюда не попадают — API там не дёргалось.
// Никогда не бросает исключение: учёт не должен ломать генерацию.
export async function addApiUsage(env, providerId, info = {}) {
  if (!env?.BOT_KV || !providerId) return;
  try {
    const key = dayKey();
    const cur = normalizeUsage(await env.BOT_KV.get(key, "json"));
    const id = String(providerId);
    const entry = cur.api[id] || { calls: 0, ok: 0, fails: 0 };
    entry.calls += 1;
    if (info.ok) entry.ok += 1; else entry.fails += 1;
    cur.api[id] = entry;

    if (info.paid) {
      const p = cur.paidImage;
      p.calls += 1;
      if (info.ok) p.ok += 1; else p.fails += 1;
      if (info.context === "morning") p.production += 1;
      else if (info.unlimited) p.ownerTests += 1;
      else if (info.context === "test" || info.testContext) p.limitedTests += 1;
      // Платит провайдер за успешные картинки: оценку стоимости копим
      // только по ok, а не по упавшим запросам.
      const cost = Number(info.unitCostUsd);
      if (info.ok && Number.isFinite(cost) && cost > 0) p.costUsd += cost;
      if (Number(info.testLimit) > 0) p.testLimit = Math.floor(Number(info.testLimit));
    }

    await env.BOT_KV.put(key, JSON.stringify(cur), { expirationTtl: 8 * 86400 });
  } catch {
    // учёт не должен ломать генерацию
  }
}

// Прибавить расход за сегодня. Никогда не бросает исключение.
export async function addUsage(env, neurons, kind = "other") {
  // ВАЖНО: neurons может быть 0 — у Gemini и NVIDIA свои лимиты,
  // и мы считаем их запросы, а не нейроны. Раньше нулевой расход
  // отсекался этой проверкой, и счётчики оставались пустыми.
  if (!env?.BOT_KV) return;
  const requestKinds = new Set(["gemini", "gemini_text", "gemini_image", "nvidia", "openrouter", "openrouter_image"]);
  if (!neurons && !requestKinds.has(kind)) return;
  if (neurons < 0) return;

  try {
    const key = dayKey();
    const cur = normalizeUsage(await env.BOT_KV.get(key, "json"));

    cur.total += neurons;
    cur.calls += 1;

    // Cloudflare тратит нейроны, у Gemini и NVIDIA свои лимиты —
    // их считаем в запросах, а не в нейронах.
    if (kind === "image") cur.image += neurons;
    else if (kind === "text") cur.text += neurons;
    else if (kind === "gemini") cur.gemini = (cur.gemini || 0) + 1;
    else if (kind === "gemini_text") {
      cur.gemini = (cur.gemini || 0) + 1;
      cur.geminiText = (cur.geminiText || 0) + 1;
    }
    else if (kind === "gemini_image") {
      cur.gemini = (cur.gemini || 0) + 1;
      cur.geminiImage = (cur.geminiImage || 0) + 1;
    }
    else if (kind === "nvidia") cur.nvidia = (cur.nvidia || 0) + 1;
    else if (kind === "openrouter" || kind === "openrouter_image") cur.openrouterImage = (cur.openrouterImage || 0) + 1;

    // Держим 8 дней, чтобы показывать историю за неделю
    await env.BOT_KV.put(key, JSON.stringify(cur), { expirationTtl: 8 * 86400 });
  } catch {
    // учёт не должен ломать генерацию
  }
}

export async function getUsage(env, offsetDays = 0) {
  try {
    return normalizeUsage(await env.BOT_KV.get(dayKey(offsetDays), "json"));
  } catch {
    return emptyUsage();
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
  const aiWarning = !env.AI
    ? "⚠️ Workers AI не подключён: Cloudflare-нейроны будут нулевые."
    : "";

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
  ];

  // Фактические вызовы image-API за сегодня: сколько раз бот реально
  // дёргал каждый провайдер (утро + тесты + health), а не только посты.
  const paid = today.paidImage || {};
  const apiEntries = Object.entries(today.api || {})
    .sort((a, b) => (b[1].calls || 0) - (a[1].calls || 0));
  lines.push("", "<b>Вызовы API картинок сегодня</b>");
  if (paid.calls || env.DEEPINFRA_API_KEY) {
    lines.push(
      `💳 DeepInfra P-Image: <b>${paid.calls || 0}</b> вызовов` +
        ` (✅ ${paid.ok || 0} · ❌ ${paid.fails || 0}) · ≈ <b>$${(paid.costUsd || 0).toFixed(3)}</b>`,
      `   🌅 утро: ${paid.production || 0} · 🧪 тесты по лимиту: ${paid.limitedTests || 0}/${paid.testLimit || 3} · 👑 тесты владельца: ${paid.ownerTests || 0}`,
    );
  }
  if (apiEntries.length) {
    for (const [id, st] of apiEntries) {
      lines.push(`• <code>${escapeHtml(id)}</code>: ${st.calls || 0} (✅ ${st.ok || 0} · ❌ ${st.fails || 0})`);
    }
  } else {
    lines.push("<i>Вызовов генерации сегодня ещё не было.</i>");
  }

  lines.push(
    "",
    "<b>Другие провайдеры</b>",
    `🟢 NVIDIA: ${today.nvidia || 0} запросов` +
      (today.nvidia ? " (свой лимит/кредиты)" : ""),
  );

  const history = await getUsageHistory(env, 7);
  const past = history.slice(1).filter((d) => d.total > 0 || d.paidImage?.calls > 0);

  if (past.length) {
    lines.push("", "<b>Предыдущие дни</b>");
    for (const d of past) {
      const p = Math.min(100, (d.total / FREE_NEURONS_PER_DAY) * 100);
      const paidNote = d.paidImage?.calls
        ? ` · 💳 DeepInfra: ${d.paidImage.calls} вызовов (≈ $${(d.paidImage.costUsd || 0).toFixed(3)})`
        : "";
      lines.push(`${d.date}: ${Math.round(d.total)} (${p.toFixed(0)}%)${paidNote}`);
    }
  }

  lines.push(
    "",
    "<i>Подсчёт локальный: Cloudflare не отдаёт остаток через API.</i>",
    "<i>Точные цифры — в дашборде Workers AI.</i>"
  );

  if (aiWarning) lines.push("", aiWarning);

  if (percent >= 90) {
    lines.push("", "🔴 <b>Лимит Cloudflare почти исчерпан</b> — бот перейдёт на запасные варианты.");
  } else if (percent >= 70) {
    lines.push("", "🟡 Cloudflare: израсходовано больше 70%.");
  }


  return lines.join("\n");
}
