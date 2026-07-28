// Генерация подписи к утренней картинке через NVIDIA LLM.
// Каждый чат задаёт свой «характер» (/set_character или .txt файлом),
// и нейросеть пишет текст под него — свой для будней и выходных.

import { getApiKeys } from "./images/nim.js";

const LLM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const TIMEOUT_MS = 12000; // укладываемся в лимит waitUntil (30 сек на всё)

// Модель текста по умолчанию. Меняется секретом NVIDIA_TEXT_MODEL
// без правки кода — например на meta/llama-3.3-70b-instruct.
const DEFAULT_LLM_MODEL = "meta/llama-3.1-8b-instruct";

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
    env.NVIDIA_TEXT_API_KEY ||
      env.NVIDIA_TEXT_API_KEYS ||
      env.NVIDIA_TEXT_API_KEY_1
  );
}

export function getTextModel(env) {
  return String(env.NVIDIA_TEXT_MODEL || DEFAULT_LLM_MODEL).trim();
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
      const response = await fetch(LLM_URL, {
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
