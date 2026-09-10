// Генерация подписи к утренней картинке через NVIDIA LLM.
// Каждый чат задаёт свой «характер» (/set_character или .txt файлом),
// и нейросеть пишет текст под него — свой для будней и выходных.

import { getApiKeys } from "./images/nim.js";
import { addUsage, estimateTextNeurons } from "./usage.js";

const TIMEOUT_MS = 12000; // укладываемся в лимит waitUntil (30 сек на всё)

// По умолчанию — NVIDIA. Оба значения меняются секретами, БЕЗ правки кода:
//   TEXT_API_URL    — адрес любого OpenAI-совместимого сервиса
//   NVIDIA_TEXT_MODEL — название модели у выбранного сервиса
//
// Формат запроса OpenAI chat/completions поддерживают: OpenAI, Groq,
// Together, DeepSeek, OpenRouter, Mistral, LM Studio, Ollama и другие.
// Достаточно поменять URL + ключ + модель.
const DEFAULT_LLM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
// meta/llama-3.3-70b-instruct умер 2026-08-26 и теперь отдаёт 410 Gone.
// Новый безопасный дефолт для NVIDIA integrate.api.nvidia.com.
const DEFAULT_LLM_MODEL = "qwen/qwen3-next-80b-a3b-instruct";
const DEFAULT_GEMINI_TEXT_MODEL = "gemini-3.5-flash";
const DEFAULT_GEMINI_TEXT_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
];

function normalizeTraits(traits) {
  if (!Array.isArray(traits)) return [];
  return traits.map((t) => String(t || "").trim()).filter(Boolean).slice(0, 12);
}

function captionTraitsBlock(traits) {
  const list = normalizeTraits(traits);
  if (!list.length) return "";
  return (
    "=== КОРОТКИЕ ХАРАКТЕРИСТИКИ ЧАТА ===\n" +
    list.map((t) => "— " + t).join("\n") +
    "\n=== КОНЕЦ ХАРАКТЕРИСТИК ===\n\n" +
    "Используй эти характеристики как общий стиль чата. Это не тема поста, " +
    "а настроение и манера: кто эти люди, как они общаются, насколько они " +
    "ироничные, добрые, технические, мемные и т.п.\n\n"
  );
}

/**
 * Бесплатная генерация текста через Cloudflare Workers AI (binding env.AI).
 * Используется, когда нет внешнего ключа или он исчерпан.
 * Те же 10 000 нейронов/сутки, что и на картинки.
 */
const CF_TEXT_MODEL = "@cf/openai/gpt-oss-20b";

export function getGeminiTextModel(env) {
  return getGeminiTextModels(env)[0];
}

export function getGeminiTextModels(env) {
  const raw = env.GEMINI_TEXT_MODELS || env.GEMINI_TEXT_MODEL || "";
  const configured = String(raw)
    .split(/[,\s]+/)
    .map((m) => m.trim().replace(/^models\//, ""))
    .filter(Boolean);
  return [...new Set([
    ...configured,
    ...DEFAULT_GEMINI_TEXT_MODELS,
    DEFAULT_GEMINI_TEXT_MODEL,
  ])];
}

function suggestedGeminiModels(errorText) {
  const out = [];
  const re = /models\/([a-zA-Z0-9_.-]+)/g;
  let m;
  while ((m = re.exec(String(errorText || "")))) out.push(m[1]);
  return [...new Set(out)];
}

async function generateViaGemini(env, messages, model = getGeminiTextModel(env)) {
  const system = messages.find((m) => m.role === "system")?.content || "";
  const user = messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n\n");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.9, topP: 0.95, maxOutputTokens: 700 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini ${response.status}: ${body.slice(0, 180)}`);
  }

  const data = await response.json();
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();
  await addUsage(env, 0, "gemini_text");
  return text;
}

async function generateViaCfBinding(env, messages) {
  // ВАЖНО: TEXT_API_MODEL — это модель для OpenAI-compatible внешнего API.
  // Для Cloudflare используем отдельную переменную CF_TEXT_MODEL, иначе старые
  // значения вроде @cf/meta/infire-llama-3.1-8b-instruct ломают fallback.
  const out = await env.AI.run(String(env.CF_TEXT_MODEL || CF_TEXT_MODEL), {
    messages,
    // temperature 1.0 заставляла llama срываться на английский
    // и китайский посреди русской фразы. 0.7 сохраняет живость.
    temperature: 0.7,
    // Кириллица у llama «дорогая»: ~1 токен на 1.2 символа. При 250 токенах
    // текст обрывался ровно на границе, на полуслове. Даём запас.
    max_tokens: 500,
  });
  const text = String(out?.response || out?.result?.response || "").trim();

  // Учёт расхода нейронов для /usage
  const inChars = messages.reduce((n, m) => n + String(m.content || "").length, 0);
  await addUsage(env, estimateTextNeurons(inChars, text.length), "text");

  return text;
}




export function getTextUrl(env) {
  return String(env.TEXT_API_URL || DEFAULT_LLM_URL).trim();
}

/**
 * Ключи для ГЕНЕРАЦИИ ТЕКСТА — отдельные от ключей для картинок.
 * У NVIDIA это разные сервисы (integrate.api vs ai.api), и ключ,
 * выданный под картинки, для текста может не работать.
 *
 * Поддерживаются:
 *   NVIDIA_TEXT_API_KEY    — один ключ
 *   NVIDIA_TEXT_API_KEYS   — несколько через запятую/перенос строки
 *   NVIDIA_TEXT_API_KEY_1..9
 *
 * Если ни один текстовый ключ не задан — берём ключи картинок
 * (обратная совместимость: вдруг ключ универсальный).
 */
export function getTextApiKeys(env) {
  const keys = [];

  // Нейтральные имена — если провайдер не NVIDIA
  if (env.TEXT_API_KEYS) {
    for (const part of String(env.TEXT_API_KEYS).split(/[,\s]+/)) {
      const k = part.trim();
      if (k) keys.push(k);
    }
  }
  if (env.TEXT_API_KEY) keys.push(String(env.TEXT_API_KEY).trim());
  for (let i = 1; i <= 9; i++) {
    const k = env[`TEXT_API_KEY_${i}`];
    if (k) keys.push(String(k).trim());
  }

  if (env.NVIDIA_TEXT_API_KEYS) {
    for (const part of String(env.NVIDIA_TEXT_API_KEYS).split(/[,\s]+/)) {
      const k = part.trim();
      if (k) keys.push(k);
    }
  }

  if (env.NVIDIA_TEXT_API_KEY) keys.push(String(env.NVIDIA_TEXT_API_KEY).trim());

  for (let i = 1; i <= 9; i++) {
    const k = env[`NVIDIA_TEXT_API_KEY_${i}`];
    if (k) keys.push(String(k).trim());
  }

  const unique = [...new Set(keys.filter(Boolean))];
  if (unique.length) return unique;

  // Если есть Gemini, текст должен идти через него, а не случайно через
  // NVIDIA-ключи для картинок. Иначе при сбое Gemini бот пробовал image-key
  // на integrate.api.nvidia.com и показывал непонятные 404/410 от LLM.
  if (env.GEMINI_API_KEY) return [];

  return getApiKeys(env); // запасной вариант — только для старых установок без Gemini
}

// Задан ли отдельный ключ под текст (для /diag)
export function hasDedicatedTextKey(env) {
  return Boolean(
    env.TEXT_API_KEY ||
      env.TEXT_API_KEYS ||
      env.TEXT_API_KEY_1 ||
      env.NVIDIA_TEXT_API_KEY ||
      env.NVIDIA_TEXT_API_KEYS ||
      env.NVIDIA_TEXT_API_KEY_1
  );
}

export function getTextModel(env) {
  return String(env.TEXT_API_MODEL || env.NVIDIA_TEXT_MODEL || DEFAULT_LLM_MODEL).trim();
}

export const DEFAULT_CHARACTER =
  "Дружелюбный рабочий чат. Нейтральный тон, лёгкий позитив, без официоза.";

// Блок с примерами для промпта.
// Формулировка важна: без явного запрета модель просто копирует
// первый пример дословно.
function exampleBlock(examples) {
  if (!Array.isArray(examples) || !examples.length) return "";

  const list = examples.map((e) => "— " + e).join("\n");

  return (
    "=== ПРИМЕРЫ УДАЧНЫХ ПОДПИСЕЙ ===\n" +
    list +
    "\n=== КОНЕЦ ПРИМЕРОВ ===\n\n" +
    "Это образец МАНЕРЫ: длина, ритм, степень иронии, подача. " +
    "НЕ копируй их и не пересказывай — напиши свежий текст в такой же " +
    "манере, но про сегодняшний день и под характер этого чата. " +
    "Повторение примера дословно — провал задачи.\n" +
    "Ориентируйся ТОЛЬКО на этот блок. Любые фразы из инструкции выше — " +
    "это пояснения для тебя, а не заготовки для ответа.\n\n"
  );
}

// Правило про день недели для промпта.
// Главное — запретить упоминать ЧУЖОЙ день: это была самая заметная
// ошибка, когда во вторник приходило «снова понедельник».
function dayRule(weekday, mention) {
  const ru = {
    Mon: "понедельник", Tue: "вторник", Wed: "среда", Thu: "четверг",
    Fri: "пятница", Sat: "суббота", Sun: "воскресенье",
  }[weekday];

  if (!ru) return "";

  const base =
    `ДЕНЬ НЕДЕЛИ: сегодня ${ru.toUpperCase()}. ` +
    "Категорически запрещено называть другой день или писать про " +
    "начало недели во вторник, про конец недели в среду и подобное. " +
    "Если сомневаешься — вообще не упоминай день.\n";

  return mention
    ? base +
      `В этой подписи ОБЫГРАЙ то, что сегодня ${ru}: настроение дня, ` +
      "его место в неделе. Не в лоб «сегодня " + ru + "», а живо.\n\n"
    : base + "В этой подписи день недели упоминать НЕ надо.\n\n";
}

// Что можно упомянуть в конкретный день недели.
const DAY_HINTS = {
  Mon: "понедельник, начало рабочей недели — тяжёлый подъём, впереди вся неделя",
  Tue: "вторник, неделя только раскачивается — до выходных далеко",
  Wed: "среда, середина недели — экватор, половина позади",
  Thu: "четверг, до конца недели один день — уже видно финиш",
  Fri: "пятница, последний рабочий день — вечером свобода",
  Sat: "суббота, первый выходной — можно отсыпаться и ничего не делать",
  Sun: "воскресенье, последний выходной — завтра снова на работу",
};

// Насколько часто подпись привязывается к конкретному дню.
// Не всегда: иначе каждый понедельник будет об одном и том же.
const DAY_MENTION_CHANCE = 0.5;

function recentCaptionsBlock(recentCaptions) {
  if (!Array.isArray(recentCaptions) || !recentCaptions.length) return "";
  return (
    "=== ПОСЛЕДНИЕ ПОДПИСИ В ЭТОМ ЧАТЕ ===\n" +
    recentCaptions.map((c) => "— " + c).join("\n") +
    "\n=== КОНЕЦ ПОСЛЕДНИХ ПОДПИСЕЙ ===\n\n" +
    "Не повторяй их начало, структуру, ключевые шутки и финальные пожелания. " +
    "Новая подпись должна звучать свежо, но в том же характере чата.\n\n"
  );
}

function buildPrompt(character, isWeekend, chatTitle, examples = [], weekday = "", holiday = "", birthdays = [], captionTraits = [], recentCaptions = []) {
  const base = holiday
    ? `праздник «${holiday}» — выходной, никакой работы, можно отдыхать`
    : isWeekend
      ? "выходной — отдых, никакой работы, можно поспать"
      : "будний рабочий день — дела, задачи, дедлайны";

  const hint = DAY_HINTS[weekday];
  const mentionDay = hint && Math.random() < DAY_MENTION_CHANCE;

  // Точный день сообщаем ВСЕГДА — чтобы модель не выдумала чужой.
  // А вот обыгрывать его просим только иногда.
  const dayType = hint ? `${hint}. По типу это ${base}` : base;

  const birthdayNames = (birthdays || []).map((b) => b.at || b.name).filter(Boolean).join(", ");

  // ВАЖНО: характер чата идёт в system-сообщение и стоит ПЕРВЫМ.
  // Раньше он был в user, а system диктовал нейтральный тон — модель
  // слушала system и выдавала пресные фразы, игнорируя иронию.
  return [
    {
      role: "system",
      content:
        "Задача — написать общее утреннее сообщение для Telegram-чата " +
        "в его манере, без обращения от конкретного человека.\n\n" +
        (String(character || "").trim()
          ? "=== РАЗВЁРНУТОЕ ОПИСАНИЕ ЧАТА ===\n" +
            character +
            "\n=== КОНЕЦ ОПИСАНИЯ ===\n\n"
          : "Характер чата развёрнуто не задан. Если есть примеры ниже — " +
            "считай их главным источником стиля и перефразируй их манеру, " +
            "не копируя дословно.\n\n") +
        captionTraitsBlock(captionTraits) +
        "Пиши как сообщение, которое подходит всей беседе: учитывай лексику, " +
        "юмор, степень иронии, теплоту и профессиональный фон из характеристик, " +
        "описания и примеров.\n\n" + 
        "Формат:\n" +
        "1. Первое предложение ВСЕГДА ровно такое: Доброе утро. " +
        "Не меняй его, не заменяй на «Добрейшего» и не добавляй к нему слова.\n" +
        "2. После него напиши ещё 1–2 коротких предложения в стиле чата. " +
        "Не начинай их заново с приветствия.\n" +
        "3. Пиши как в примерах: простая бытовая мысль, лёгкая рабочая ирония, " +
        "без перегруженных метафор и длинных рассуждений.\n" +
        "4. Не пиши несколько вариантов подписи подряд. Нужен один цельный текст, " +
        "а не набор альтернатив.\n" + 
        "5. Обычно 90–260 символов. Лучше коротко и законченно, чем длинно. " +
        "Одно предложение после приветствия — нормально.\n" +
        "6. Без хэштегов, markdown, кавычек вокруг ответа и многоточий.\n\n" + 
        "ЗАПРЕЩЕНО писать безликие штампы вроде «Пусть день будет " +
        "продуктивным», «Начинаем день на позитиве», «Отличного дня». " +
        "Такие фразы — провал задачи.\n\n" +
        "СМЫСЛ ВАЖНЕЕ ОРИГИНАЛЬНОСТИ. Можно шутить и писать характерно, " +
        "но каждое предложение должно быть осмысленным по-русски. Если шутка " +
        "получается слишком сложной — упрощай. Не используй тяжёлые конструкции " +
        "вроде «архитектура планов», «точка бифуркации», «пересборка реальности», " +
        "«системная ошибка недели».\n\n" +
        "ЯЗЫК: пиши СТРОГО на русском языке, кириллицей. Ни одного слова " +
        "и ни одного символа на английском, китайском, арабском или любом " +
        "другом языке. Латиница допустима только в общепринятых названиях " +
        "(Python, Telegram). Текст с иероглифами или вставками вроде " +
        "«myself» — провал задачи.\n\n" +
        "Закончи мысль до конца: последнее предложение должно быть " +
        "завершённым, с точкой. Не ставь многоточие и не оставляй фразу " +
        "подвешенной. Лучше короче, чем оборвать на полуслове.\n\n" +
        (holiday
          ? `ПРАЗДНИК: сегодня ${holiday}. Это выходной, не называй его рабочим днём и не пиши про дедлайны/офис как обязательные дела.\n\n`
          : "") +
        dayRule(weekday, mentionDay && !holiday) +
        (birthdayNames
          ? `ДЕНЬ РОЖДЕНИЯ: сегодня день рождения у ${birthdayNames}. Обязательно поздравь их тепло, но коротко.\n\n`
          : "") +
        recentCaptionsBlock(recentCaptions) +
        exampleBlock(examples) +
        "Верни ТОЛЬКО текст приветствия.",
    },
    {
      role: "user",
      content:
        (chatTitle ? `Чат: ${chatTitle}. ` : "") +
        `Сегодня ${dayType}.\n\n` +
        "Напиши приветствие в стиле этого чата.",
    },
  ];
}

function cleanup(text) {
  let out = String(text || "").trim();

  // модель иногда оборачивает ответ в кавычки
  out = out.replace(/^["«„']+|["»“']+$/g, "").trim();
  // убираем markdown-разметку, Telegram парсит HTML
  out = out.replace(/[*_`#]/g, "");
  // только первый абзац
  out = out.split(/\n{2,}/)[0].trim();

  // Обрезаем по последнему законченному предложению, а не по символу:
  // иначе подпись обрывалась на полуслове («профессиональной денонсаци»).
  out = trimToSentence(out, 700);

  // Пользователь попросил стабильную структуру: первое предложение всегда
  // «Доброе утро.», а дальше уже сгенерированная часть. Делаем это кодом,
  // а не только промптом, чтобы модель не копировала варианты из примеров.
  out = normalizeMorningOpening(out);

  return out;
}

function normalizeMorningOpening(text) {
  let out = String(text || "").trim();
  if (!out) return out;

  // Если модель начала с вариации приветствия, заменяем только её,
  // остальной текст оставляем как есть.
  out = out.replace(
    /^(?:всем\s+)?(?:доброе\s+утро|добрейшего|с\s+добрым\s+утром)[!,.\s—-]*/iu,
    ""
  ).trim();

  if (!out) return "Доброе утро.";
  return "Доброе утро. " + out.replace(/^[-—\s]+/, "");
}

// Обрезка до последнего законченного предложения.
// Текст не должен обрываться на полуслове: либо режем по точке,
// либо возвращаем неполный хвост, который captionProblem забракует.
function trimToSentence(text, limit) {
  const out = String(text || "").trim();
  const head = out.length > limit ? out.slice(0, limit) : out;

  // Уже заканчивается нормально — ничего не делаем
  if (out.length <= limit && /[.!?…»)]$/.test(head)) return head;

  const lastEnd = Math.max(head.lastIndexOf("."), head.lastIndexOf("!"),
                           head.lastIndexOf("?"), head.lastIndexOf("…"));

  // Режем по последней точке, только если остаётся хотя бы 60% текста
  if (lastEnd >= 0 && lastEnd + 1 >= head.length * 0.6) {
    return head.slice(0, lastEnd + 1).trim();
  }

  // Иначе возвращаем неполный хвост без искусственного многоточия: ниже
  // captionProblem забракует такой ответ и даст шанс следующей модели/фолбэку.
  return head.trimEnd();
}

/**
 * Проверка качества подписи ПЕРЕД отправкой в чат.
 *
 * Модель llama-3.1-8b при temperature 1.0 иногда «сползает» на другие
 * языки прямо посреди русской фразы: «обещаю myself все今天 …».
 * Такой текст лучше не показывать — пусть сработает запасной вариант.
 *
 * Возвращает null, если всё хорошо, или причину брака строкой.
 */
export function captionProblem(text) {
  const out = String(text || "").trim();
  if (!out) return "пустой ответ";

  // Иероглифы, арабица, иврит, деванагари — в русской подписи их быть не может
  const foreign = out.match(/[\u4E00-\u9FFF\u3040-\u30FF\u0600-\u06FF\u0590-\u05FF\u0900-\u097F]/g);
  if (foreign) return `чужие символы: ${[...new Set(foreign)].join("")}`;

  const letters = out.match(/\p{L}/gu) || [];
  if (!letters.length) return "нет букв";

  // Не показываем оборванные ответы. Многоточие в этих подписях почти всегда
  // выглядит как обрыв мысли, особенно когда модель зависла на начале фразы.
  if (/…|\.\.\./.test(out)) return "многоточие/обрыв фразы";
  if (!/[.!?»)]$/.test(out)) return "незаконченное последнее предложение";

  const lower = out.toLowerCase();
  const greetingMatches = lower.match(/(^|[^\p{L}])(доброе утро|добрейшего|с добрым утром)(?=$|[^\p{L}])/gu) || [];
  if (greetingMatches.length > 1) return "повтор приветствия";

  const weekdayMatches = lower.match(/(^|[^\p{L}])(понедельник|вторник|среда|четверг|пятница|суббота|воскресенье)(?=$|[^\p{L}])/gu) || [];
  if (weekdayMatches.length > 2) return "повтор дня недели";

  const sentences = out.match(/[^.!?]+[.!?]/g) || [];
  if (sentences.length > 3) return "слишком много предложений";
  if (out.length > 320) return "слишком длинная подпись";
  const tooLongSentence = sentences.find((s) => s.trim().length > 185);
  if (tooLongSentence) return "слишком длинное предложение";

  const heavyPhrases = [
    "архитектура планов",
    "точка бифуркации",
    "пересборка реальности",
    "системная ошибка недели",
    "сборочные единицы",
    "фатальных ошибок",
    "экстренного перепроектирования",
  ];
  if (heavyPhrases.some((p) => lower.includes(p))) return "перегруженная метафора";

  // Сначала латинские СЛОВА: доли процентов мало — «обещаю myself» это
  // 95% кириллицы, но читается как брак.
  const allowed = new Set([
    "telegram", "python", "javascript", "js", "html", "css", "sql",
    "github", "google", "cloudflare", "openai", "chatgpt", "ai",
    "windows", "linux", "macos", "android", "ios", "wifi", "usb",
    "pdf", "excel", "word", "zoom", "email", "ok", "it", "hr", "pr",
  ]);

  const latinWords = out.match(/[A-Za-z][A-Za-z'-]{1,}/g) || [];
  const bad = latinWords.filter((w) => !allowed.has(w.toLowerCase()));
  if (bad.length) return "иностранные слова: " + bad.slice(0, 3).join(", ");

  // Долю кириллицы считаем БЕЗ разрешённых названий: короткая фраза
  // «Деплоим в Telegram и отдыхаем» иначе не проходила порог.
  const stripped = out.replace(/[A-Za-z][A-Za-z'-]{1,}/g, "");
  const strippedLetters = stripped.match(/\p{L}/gu) || [];
  const cyrillic = stripped.match(/[\u0400-\u04FF]/g) || [];

  if (!cyrillic.length) return "текст не на русском";
  if (cyrillic.length / strippedLetters.length < 0.8) {
    return "текст не на русском";
  }

  return null;
}

/**
 * Возвращает { ok, text, model, latency, error }.
 * Никогда не бросает исключение — при сбое вызывающий код берёт запасную фразу.
 */
export async function generateCaption(env, options = {}) {
  const {
    character = "",
    isWeekend = false,
    chatTitle = "",
    examples = [],
    weekday = "",
    holidayName = "",
    birthdays = [],
    captionTraits = [],
    recentCaptions = [],
    textProvider = "gemini",
  } = options;

  const keys = getTextApiKeys(env);
  const model = getTextModel(env);
  const textModels = [...new Set([model, DEFAULT_LLM_MODEL, "qwen/qwq-32b"].filter(Boolean))];
  const started = Date.now();
  const messages = buildPrompt(
    character,
    isWeekend,
    chatTitle,
    examples,
    weekday,
    holidayName,
    birthdays,
    captionTraits,
    recentCaptions
  );
  let lastError = null;
  let geminiError = null;

  const mode = String(textProvider || "gemini").toLowerCase();

  // ПРИОРИТЕТ: Gemini (если есть GEMINI_API_KEY) — сейчас это
  // основной путь для текста. Пробуем несколько актуальных моделей по очереди.
  if (mode !== "external" && mode !== "cf" && env.GEMINI_API_KEY && String(env.DISABLE_GEMINI_TEXT || "") !== "1") {
    try {
      const geminiModels = getGeminiTextModels(env);
      for (let i = 0; i < geminiModels.length; i++) {
        try {
          const modelName = geminiModels[i];
          const text = cleanup(await generateViaGemini(env, messages, modelName));
          const problem = captionProblem(text);
          if (text && !problem) {
            return { ok: true, text, model: "gemini/" + modelName,
                     latency: Date.now() - started };
          }
          geminiError = problem ? `Gemini ${modelName} выдал брак (${problem})` : `Gemini ${modelName} вернул пустой ответ`;
          lastError = geminiError;
        } catch (e) {
          const msg = String(e?.message || e);
          geminiError = msg.slice(0, 220);
          lastError = geminiError;
          // Если Google прямо подсказал новый models/..., добавляем его в очередь.
          for (const suggested of suggestedGeminiModels(msg)) {
            if (!geminiModels.includes(suggested)) geminiModels.splice(i + 1, 0, suggested);
          }
        }
      }
    } catch (e) {
      geminiError = String(e?.message || e).slice(0, 180);
      lastError = geminiError;
    }
  }

  if (mode === "gemini") {
    return {
      ok: false,
      error: geminiError || "выбран Gemini для текста, но GEMINI_API_KEY не задан или Gemini не ответил",
      latency: Date.now() - started,
    };
  }

  // Cloudflare можно принудительно оставить первым: PREFER_CF_TEXT=1.
  const preferCf = env.AI && String(env.PREFER_CF_TEXT || "") === "1";

  if (preferCf) {
      try {
        const text = cleanup(await generateViaCfBinding(env, messages));
        const problem = captionProblem(text);
        if (text && !problem) {
          return { ok: true, text, model: "cloudflare/" + String(env.CF_TEXT_MODEL || CF_TEXT_MODEL),
                   latency: Date.now() - started };
        }
        return { ok: false, error: problem
          ? `Workers AI выдал брак (${problem})`
          : "Workers AI вернул пустой ответ" };
    } catch (e) {
      lastError = "Workers AI: " + String(e?.message || e).slice(0, 150);
    }
    // не получилось — идём во внешние ключи ниже
  }

  if (mode === "cf" || !keys.length) {
    if (env.AI) {
      try {
        const text = cleanup(await generateViaCfBinding(env, messages));
        const problem = captionProblem(text);
        if (text && !problem) {
          return { ok: true, text, model: "cloudflare/" + String(env.CF_TEXT_MODEL || CF_TEXT_MODEL),
                   latency: Date.now() - started };
        }
        return { ok: false, error: problem
          ? `Workers AI выдал брак (${problem})`
          : "Workers AI вернул пустой ответ" };
      } catch (e) {
        return { ok: false, error: "Workers AI: " + String(e?.message || e).slice(0, 150) };
      }
    }
    return { ok: false, error: "нет ключа для текста (TEXT_API_KEY) и не включён binding [ai]" };
  }

  for (const currentModel of textModels) {
    for (let i = 0; i < Math.min(keys.length, 2); i++) {
      try {
        const response = await fetch(getTextUrl(env), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${keys[i]}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            model: currentModel,
            messages,
            temperature: 0.7,
            top_p: 0.9,
            // presence_penalty гонит модель от заезженных формулировок
            presence_penalty: 0.6,
            frequency_penalty: 0.3,
            // см. комментарий про кириллицу выше
            max_tokens: 500,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (!response.ok) {
          const body = await response.text();
          lastError = `LLM ${response.status} (${currentModel}): ${body.slice(0, 150)}`;
          // 410 Gone — модель снята с обслуживания: пробуем следующий model id.
          if (response.status === 410) break;
          // 401/403/429 — пробуем следующий ключ
          if ([401, 403, 429].includes(response.status) && i + 1 < keys.length) continue;
          // Любая другая ошибка (402 «кончились кредиты», 5xx) — выходим из цикла
          // и пробуем следующую модель / бесплатный Workers AI ниже.
          break;
        }

        const data = await response.json();
        const raw = data?.choices?.[0]?.message?.content;
        const text = cleanup(raw);

        if (!text) {
          lastError = `пустой ответ модели ${currentModel}`;
          continue;
        }

        // Модель могла сползти на другой язык — тогда пробуем следующий
        // ключ/модель, а не отдаём в чат текст с иероглифами.
        const problem = captionProblem(text);
        if (problem) {
          lastError = `модель ${currentModel} выдала брак (${problem})`;
          continue;
        }

        return {
          ok: true,
          text,
          model: currentModel,
          latency: Date.now() - started,
        };
      } catch (e) {
        lastError = String(e).slice(0, 150);
        if (i + 1 >= keys.length) break;
      }
    }
  }

  // Все внешние ключи отказали — пробуем бесплатный Workers AI.
  if (env.AI) {
    try {
      const text = cleanup(await generateViaCfBinding(env, messages));
      if (text && !captionProblem(text)) {
        return { ok: true, text, model: "cloudflare/" + String(env.CF_TEXT_MODEL || CF_TEXT_MODEL),
                 latency: Date.now() - started, fallback: true };
      }
    } catch {
      // ниже вернём общую ошибку
    }
  }

  return {
    ok: false,
    error: geminiError && lastError && lastError !== geminiError
      ? `${geminiError}; fallback: ${lastError}`
      : lastError || "все ключи не сработали",
    latency: Date.now() - started,
  };
}




// ─────────────────────────────────────────────────────────────────────
// Перевод промпта на английский.
//
// Модели генерации картинок (CLIP/T5) обучены почти только на английском.
// Русский текст они не понимают — выдают случайный результат.
// Поэтому промпт с кириллицей переводим перед отправкой.
//
// Перевод КЭШИРУЕТСЯ в KV навсегда: один и тот же промпт из библиотеки
// переводится один раз, дальше берётся готовый. Это важно, потому что
// у Cloudflare всего 30 секунд на весь запрос.
// ─────────────────────────────────────────────────────────────────────

const TRANSLATE_TIMEOUT_MS = 8000;

// Есть ли в тексте кириллица (быстрая проверка, без запросов)
export function needsTranslation(text) {
  return /[\u0400-\u04FF]/.test(String(text || ""));
}

// Короткий стабильный ключ кэша по тексту
function cacheKeyFor(text) {
  let h = 2166136261;
  const str = String(text);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `tr:${(h >>> 0).toString(36)}:${str.length}`;
}

/**
 * Переводит промпт на английский, если в нём есть кириллица.
 * Английский текст возвращается как есть — без единого запроса.
 *
 * Возвращает { text, translated, cached, error }.
 * При любой ошибке возвращает исходный текст: генерация не должна падать
 * из-за проблем с переводом.
 */
export async function translatePrompt(prompt, env) {
  const original = String(prompt || "").trim();

  if (original.length < 3) return { text: original, translated: false };
  if (!needsTranslation(original)) return { text: original, translated: false };

  const key = cacheKeyFor(original);

  // 1. Готовый перевод из кэша — мгновенно, без запроса к API
  try {
    const cached = await env.BOT_KV.get(key);
    if (cached) return { text: cached, translated: true, cached: true };
  } catch {
    // кэш недоступен — не страшно, переведём заново
  }

  const keys = getTextApiKeys(env);

  if (env.GEMINI_API_KEY && String(env.DISABLE_GEMINI_TEXT || "") !== "1") {
    try {
      for (const modelName of getGeminiTextModels(env)) {
        try {
          const t = await generateViaGemini(env, [
            { role: "system", content: "Translate the user's image-generation prompt from Russian to English. Reply with the English prompt only. No explanations, no quotes." },
            { role: "user", content: original },
          ], modelName);
          const clean = String(t || "").trim().replace(/^["«„']+|["»“']+$/g, "");
          if (clean && !needsTranslation(clean)) {
            try { await env.BOT_KV.put(key, clean, { expirationTtl: 90 * 24 * 60 * 60 }); } catch {}
            return { text: clean, translated: true, cached: false, provider: "gemini" };
          }
        } catch {
          // пробуем следующую Gemini-модель
        }
      }
    } catch {
      // не вышло — пробуем остальные способы ниже
    }
  }

  // Приоритет для перевода — бесплатный Workers AI, внешние ключи запасные
  const preferCf = env.AI && String(env.PREFER_EXTERNAL_TEXT || "") !== "1";

  if (preferCf || !keys.length) {
    if (!env.AI) return { text: original, translated: false, error: "нет ключа для перевода" };
    try {// молча возвращаем оригинал ниже
      const out = await env.AI.run(CF_TEXT_MODEL, {
        messages: [
          { role: "system", content: "Translate the user's image prompt from Russian to English. Reply with the English prompt only." },
          { role: "user", content: original },
        ],
        max_tokens: 400,
      });
      let t = String(out?.response || "").trim().replace(/^["«„']+|["»“']+$/g, "");
      await addUsage(env, estimateTextNeurons(original.length + 120, t.length), "text");
      if (t && !needsTranslation(t)) {
        try { await env.BOT_KV.put(key, t, { expirationTtl: 90 * 24 * 60 * 60 }); } catch {}
        return { text: t, translated: true, cached: false };
      }
    } catch {
      // не вышло — если есть внешние ключи, пробуем их ниже
    }
    if (!keys.length) {
      return { text: original, translated: false, error: "Workers AI не перевёл" };
    }
  }

  try {
    const response = await fetch(getTextUrl(env), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${keys[0]}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: getTextModel(env),
        messages: [
          {
            role: "system",
            content:
              "You translate image-generation prompts from Russian to English. " +
              "Rules:\n" +
              "1. Output ONLY the English prompt, nothing else.\n" +
              "2. Keep it as a comma-separated visual description.\n" +
              "3. Preserve all details: objects, colors, lighting, style, mood.\n" +
              "4. Do not add explanations, quotes or commentary.\n" +
              "5. If the text is already English, return it unchanged.",
          },
          { role: "user", content: original },
        ],
        temperature: 0.2,
        // хватает на промпт до ~1500 символов после перевода
        max_tokens: 600,
      }),
      signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { text: original, translated: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    let out = String(data?.choices?.[0]?.message?.content || "").trim();

    out = out.replace(/^["«„']+|["»“']+$/g, "").trim();
    out = out.replace(/[*_`#]/g, "");
    out = out.split(/\n{2,}/)[0].trim();

    // Перевод не удался — в ответе всё ещё кириллица
    if (!out || needsTranslation(out)) {
      return { text: original, translated: false, error: "модель не перевела" };
    }

    // Кладём в кэш на 90 дней
    try {
      await env.BOT_KV.put(key, out, { expirationTtl: 90 * 24 * 60 * 60 });
    } catch {
      // не критично
    }

    return { text: out, translated: true, cached: false };
  } catch (e) {
    return { text: original, translated: false, error: String(e).slice(0, 100) };
  }
}
