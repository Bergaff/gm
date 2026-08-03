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
const DEFAULT_LLM_MODEL = "meta/llama-3.1-8b-instruct";


/**
 * Бесплатная генерация текста через Cloudflare Workers AI (binding env.AI).
 * Используется, когда нет внешнего ключа или он исчерпан.
 * Те же 10 000 нейронов/сутки, что и на картинки.
 */
const CF_TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct";

async function generateViaCfBinding(env, messages) {
  const out = await env.AI.run(String(env.TEXT_API_MODEL || CF_TEXT_MODEL), {
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

  return getApiKeys(env); // запасной вариант — ключи для картинок
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
    "Повторение примера дословно — провал задачи.\n\n"
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

function buildPrompt(character, isWeekend, chatTitle, examples = [], weekday = "") {
  const base = isWeekend
    ? "выходной — отдых, никакой работы, можно поспать"
    : "будний рабочий день — дела, задачи, дедлайны";

  const hint = DAY_HINTS[weekday];
  const mentionDay = hint && Math.random() < DAY_MENTION_CHANCE;

  // Точный день сообщаем ВСЕГДА — чтобы модель не выдумала чужой.
  // А вот обыгрывать его просим только иногда.
  const dayType = hint ? `${hint}. По типу это ${base}` : base;

  // ВАЖНО: характер чата идёт в system-сообщение и стоит ПЕРВЫМ.
  // Раньше он был в user, а system диктовал нейтральный тон — модель
  // слушала system и выдавала пресные фразы, игнорируя иронию.
  return [
    {
      role: "system",
      content:
        "Ты — участник этого Telegram-чата и пишешь утреннее приветствие " +
        "ИМЕННО В ЕГО СТИЛЕ.\n\n" +
        "=== ХАРАКТЕР ЧАТА (главное правило) ===\n" +
        character +
        "\n=== КОНЕЦ ОПИСАНИЯ ===\n\n" +
        "Пиши так, будто ты свой в этом чате: та же лексика, тот же юмор, " +
        "та же степень иронии и неформальности. Если чат ироничный — " +
        "шути. Если грубоватый — не сглаживай. Если сленговый — используй сленг.\n\n" +
        "Формат:\n" +
        "1. Поздоровайся своими словами. Можно «Доброе утро», можно " +
        "иначе — лишь бы звучало живо и по-разному каждый раз. " +
        "НЕ копируй примеры из этой инструкции дословно.\n" +
        "2. ДЛИНА СВОБОДНАЯ. Иногда достаточно одной короткой фразы " +
        "(«Доброе утро, мы начали.»), иногда — одного наблюдения на " +
        "два предложения. Не дописывай ничего ради объёма: если мысль " +
        "закончилась, останавливайся.\n" +
        "3. До 250 символов.\n" +
        "4. Без хэштегов, markdown и кавычек вокруг ответа.\n\n" +
        "ЗАПРЕЩЕНО писать безликие штампы вроде «Пусть день будет " +
        "продуктивным», «Начинаем день на позитиве», «Отличного дня». " +
        "Такие фразы — провал задачи.\n\n" +
        "СМЫСЛ ВАЖНЕЕ ОРИГИНАЛЬНОСТИ. Лучше простая понятная фраза, чем " +
        "красивый набор слов. Если получается бессвязица вроде " +
        "«Картонами полицейские стоят на каждом углу» — выброси и напиши " +
        "проще. Каждое предложение должно быть осмысленным по-русски.\n\n" +
        "ЯЗЫК: пиши СТРОГО на русском языке, кириллицей. Ни одного слова " +
        "и ни одного символа на английском, китайском, арабском или любом " +
        "другом языке. Латиница допустима только в общепринятых названиях " +
        "(Python, Telegram). Текст с иероглифами или вставками вроде " +
        "«myself» — провал задачи.\n\n" +
        "Закончи мысль до конца: последнее предложение должно быть " +
        "завершённым, с точкой. Лучше короче, чем оборвать на полуслове.\n\n" +
        dayRule(weekday, mentionDay) +
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
  out = trimToSentence(out, 400);

  return out;
}

// Обрезка до последнего законченного предложения.
// Текст не должен обрываться на полуслове: либо режем по точке,
// либо ставим многоточие, чтобы обрыв выглядел намеренным.
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

  // Иначе — обрываем по последнему целому слову и ставим многоточие
  const cut = head.replace(/\s+\S*$/, "").trimEnd();
  return (cut || head.trimEnd()).replace(/[,;:\s]+$/, "") + "…";
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
    character = DEFAULT_CHARACTER,
    isWeekend = false,
    chatTitle = "",
    examples = [],
    weekday = "",
  } = options;

  const keys = getTextApiKeys(env);
  const model = getTextModel(env);
  const started = Date.now();
  const messages = buildPrompt(character, isWeekend, chatTitle, examples, weekday);
  let lastError = null;

  // ПРИОРИТЕТ: сначала бесплатный Cloudflare Workers AI. Внешние ключи
  // (NVIDIA и прочие) — только если он недоступен или не справился.
  // Отключить приоритет: секрет PREFER_EXTERNAL_TEXT = "1".
  const preferCf = env.AI && String(env.PREFER_EXTERNAL_TEXT || "") !== "1";

  if (preferCf) {
      try {
        const text = cleanup(await generateViaCfBinding(env, messages));
        const problem = captionProblem(text);
        if (text && !problem) {
          return { ok: true, text, model: "cloudflare/" + CF_TEXT_MODEL,
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

  if (!keys.length) {
    if (env.AI) {
      try {
        const text = cleanup(await generateViaCfBinding(env, messages));
        if (text) {
          return { ok: true, text, model: "cloudflare/" + CF_TEXT_MODEL,
                   latency: Date.now() - started };
        }
        return { ok: false, error: "Workers AI вернул пустой ответ" };
      } catch (e) {
        return { ok: false, error: "Workers AI: " + String(e?.message || e).slice(0, 150) };
      }
    }
    return { ok: false, error: "нет ключа для текста (TEXT_API_KEY) и не включён binding [ai]" };
  }

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
          model,
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
        lastError = `LLM ${response.status}: ${body.slice(0, 150)}`;
        // 401/403/429 — пробуем следующий ключ
        if ([401, 403, 429].includes(response.status) && i + 1 < keys.length) continue;
        // Любая другая ошибка (402 «кончились кредиты», 5xx) — выходим из цикла
        // и пробуем бесплатный Workers AI ниже, а не сдаёмся сразу.
        break;
      }

      const data = await response.json();
      const raw = data?.choices?.[0]?.message?.content;
      const text = cleanup(raw);

      if (!text) {
        return { ok: false, error: "пустой ответ модели", latency: Date.now() - started };
      }

      // Модель могла сползти на другой язык — тогда пробуем следующий
      // ключ, а не отдаём в чат текст с иероглифами.
      const problem = captionProblem(text);
      if (problem) {
        lastError = `модель выдала брак (${problem})`;
        continue;
      }

      return {
        ok: true,
        text,
        model,
        latency: Date.now() - started,
      };
    } catch (e) {
      lastError = String(e).slice(0, 150);
      if (i + 1 >= keys.length) break;
    }
  }

  // Все внешние ключи отказали — пробуем бесплатный Workers AI.
  if (env.AI) {
    try {
      const text = cleanup(await generateViaCfBinding(env, messages));
      if (text && !captionProblem(text)) {
        return { ok: true, text, model: "cloudflare/" + CF_TEXT_MODEL,
                 latency: Date.now() - started, fallback: true };
      }
    } catch {
      // ниже вернём общую ошибку
    }
  }

  return { ok: false, error: lastError || "все ключи не сработали", latency: Date.now() - started };
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

  // Приоритет — бесплатный Workers AI, внешние ключи запасные
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
