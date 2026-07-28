// Генерация подписи к утренней картинке через NVIDIA LLM.
// Каждый чат задаёт свой «характер» (/set_character или .txt файлом),
// и нейросеть пишет текст под него — свой для будней и выходных.

import { getApiKeys } from "./images/nim.js";

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

function buildPrompt(character, isWeekend, chatTitle) {
  const dayType = isWeekend
    ? "выходной день — отдых, спокойствие, личные дела"
    : "будний рабочий день — продуктивность, задачи, рабочий настрой";

  return [
    {
      role: "system",
      content:
        "Ты пишешь короткие утренние приветствия для Telegram-чата на русском языке. " +
        "Правила:\n" +
        "1. Всегда начинай с «Доброе утро».\n" +
        "2. Затем ОДНО предложение на злободневную тему дня.\n" +
        "3. Всего не более 200 символов.\n" +
        "4. Без хэштегов, без markdown, без кавычек вокруг ответа.\n" +
        "5. Живой человеческий тон, не канцелярит.\n" +
        "Верни ТОЛЬКО текст приветствия, без пояснений.",
    },
    {
      role: "user",
      content:
        `Характер чата: ${character}\n` +
        (chatTitle ? `Название чата: ${chatTitle}\n` : "") +
        `Сегодня: ${dayType}.\n\n` +
        "Напиши приветствие.",
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

  if (out.length > 400) out = out.slice(0, 397).trimEnd() + "…";
  return out;
}

/**
 * Возвращает { ok, text, model, latency, error }.
 * Никогда не бросает исключение — при сбое вызывающий код берёт запасную фразу.
 */
export async function generateCaption(env, options = {}) {
  const { character = DEFAULT_CHARACTER, isWeekend = false, chatTitle = "" } = options;

  const keys = getTextApiKeys(env);
  if (!keys.length) {
    return { ok: false, error: "нет ключа NVIDIA для текста (NVIDIA_TEXT_API_KEY)" };
  }

  const model = getTextModel(env);

  const started = Date.now();

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
          messages: buildPrompt(character, isWeekend, chatTitle),
          temperature: 0.9,
          top_p: 0.95,
          max_tokens: 160,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text();
        // 401/403/429 — пробуем следующий ключ
        if ([401, 403, 429].includes(response.status) && i + 1 < keys.length) continue;
        return {
          ok: false,
          error: `LLM ${response.status}: ${body.slice(0, 150)}`,
          latency: Date.now() - started,
        };
      }

      const data = await response.json();
      const raw = data?.choices?.[0]?.message?.content;
      const text = cleanup(raw);

      if (!text) {
        return { ok: false, error: "пустой ответ модели", latency: Date.now() - started };
      }

      return {
        ok: true,
        text,
        model,
        latency: Date.now() - started,
      };
    } catch (e) {
      if (i + 1 >= keys.length) {
        return { ok: false, error: String(e).slice(0, 150), latency: Date.now() - started };
      }
    }
  }

  return { ok: false, error: "все ключи не сработали", latency: Date.now() - started };
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

  if (!original) return { text: original, translated: false };
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
  if (!keys.length) {
    return { text: original, translated: false, error: "нет ключа для перевода" };
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
        max_tokens: 200,
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
