import { addUsage, estimateImageNeurons } from "../usage.js";
import { imageProblem } from "./quality.js";

const BASE = "https://ai.api.nvidia.com/v1/genai";
// ВАЖНО: waitUntil() в Cloudflare даёт всего 30 секунд после ответа на webhook.
// Таймаут 55 сек означал, что воркер убивали РАНЬШЕ, чем срабатывал таймаут —
// поэтому /test и /nim_health молча ничего не присылали.
// Крон (scheduled) имеет лимит 15 минут, поэтому по расписанию картинки приходили.
const TIMEOUT_MS = 20000;
const FAIL_COOLDOWN = 30 * 60;

/**
 * Пул ключей NVIDIA. Поддерживаются:
 *   NVIDIA_API_KEY   — один ключ (как раньше)
 *   NVIDIA_API_KEYS  — несколько через запятую или перевод строки
 *   NVIDIA_API_KEY_1 ... NVIDIA_API_KEY_9 — по отдельности
 * Ключи перебираются: если один упёрся в лимит (429) или протух (401/403),
 * автоматически берётся следующий.
 */
export function getApiKeys(env) {
  const keys = [];

  if (env.NVIDIA_API_KEYS) {
    for (const part of String(env.NVIDIA_API_KEYS).split(/[,\s]+/)) {
      const k = part.trim();
      if (k) keys.push(k);
    }
  }

  if (env.NVIDIA_API_KEY) keys.push(String(env.NVIDIA_API_KEY).trim());

  for (let i = 1; i <= 9; i++) {
    const k = env[`NVIDIA_API_KEY_${i}`];
    if (k) keys.push(String(k).trim());
  }

  return [...new Set(keys.filter(Boolean))];
}

// Ключ считается временно негодным после 401/403/429
const keyFailKey = (idx) => `nimkeyfail:${idx}`;

async function pickKeyIndex(keys, env) {
  for (let i = 0; i < keys.length; i++) {
    if (!(await env.BOT_KV.get(keyFailKey(i)))) return i;
  }
  return 0; // все в кулдауне — пробуем первый
}

function markKeyFailed(idx, env, status) {
  const ttl = status === 429 ? 15 * 60 : 60 * 60;
  return env.BOT_KV.put(keyFailKey(idx), "1", { expirationTtl: ttl });
}

/**
 * Реестр моделей NVIDIA NIM.
 * Порядок = приоритет при nimModel = "auto".
 * Если NVIDIA переименует модель — правится только этот файл.
 */
export const NIM_PROVIDERS = [
  {
    id: "flux-schnell",
    title: "FLUX.1 schnell",
    url: `${BASE}/black-forest-labs/flux.1-schnell`,
    build: (prompt, seed) => ({
      prompt, mode: "base", cfg_scale: 3.5,
      width: 1024, height: 1024, seed, steps: 4,
    }),
  },
  {
    id: "flux-dev",
    title: "FLUX.1 dev",
    url: `${BASE}/black-forest-labs/flux.1-dev`,
    build: (prompt, seed) => ({
      prompt, mode: "base", cfg_scale: 3.5,
      width: 1024, height: 1024, seed, steps: 28,
    }),
  },
  {
    id: "sd3-medium",
    title: "Stable Diffusion 3 Medium",
    url: `${BASE}/stabilityai/stable-diffusion-3-medium`,
    build: (prompt, seed) => ({
      prompt, mode: "base", cfg_scale: 5,
      aspect_ratio: "1:1", seed, steps: 50,
    }),
  },
  {
    // Отключена: качество ниже остальных в пуле.
    disabled: true,
    id: "sdxl",
    title: "Stable Diffusion XL",
    url: `${BASE}/stabilityai/stable-diffusion-xl`,
    build: (prompt, seed) => ({
      text_prompts: [{ text: prompt, weight: 1 }],
      cfg_scale: 5, sampler: "K_DPM_2_ANCESTRAL", seed, steps: 25,
    }),
  },
  {
    // Отключена: качество ниже остальных в пуле.
    disabled: true,
    id: "bria-23",
    title: "BRIA 2.3",
    url: `${BASE}/briaai/bria-2.3`,
    build: (prompt, seed) => ({
      prompt,
      negative_prompt: "text, watermark, logo, low quality, blurry",
      cfg_scale: 5, aspect_ratio: "1:1", seed, steps: 30,
    }),
  },
];

/**
 * ДОПОЛНИТЕЛЬНЫЕ провайдеры картинок — задаются секретом IMAGE_PROVIDERS_JSON,
 * без правки этого файла. Встроенные модели NVIDIA выше остаются на месте.
 *
 * Формат секрета — JSON-массив:
 * [
 *   {
 *     "id": "sdxl-hf",
 *     "title": "SDXL (HuggingFace)",
 *     "url": "https://api-inference.huggingface.co/models/stabilityai/...",
 *     "keyEnv": "HF_API_KEY",
 *     "format": "raw",
 *     "body": { "inputs": "{prompt}" }
 *   }
 * ]
 *
 * Поля:
 *   id, title  — как показывать в /models
 *   url        — endpoint
 *   keyEnv     — ИМЯ переменной с ключом (не сам ключ!)
 *   authHeader — "bearer" (по умолчанию) | "x-api-key" | "none"
 *   format     — "json" (по умолчанию, ищем base64/url в ответе) | "raw" (тело = сами байты)
 *   body       — шаблон тела запроса; {prompt} и {seed} подставляются
 */
export function getCustomProviders(env) {
  const raw = env.IMAGE_PROVIDERS_JSON;
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return []; // битый JSON не должен ронять бота
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((p) => p && p.id && p.url)
    .map((p) => ({
      id: String(p.id),
      title: String(p.title || p.id),
      url: String(p.url),
      keyEnv: p.keyEnv ? String(p.keyEnv) : null,
      authHeader: String(p.authHeader || "bearer").toLowerCase(),
      format: String(p.format || "json").toLowerCase(),
      custom: true,
      build: (prompt, seed) => fillTemplate(p.body ?? { prompt: "{prompt}" }, prompt, seed),
    }));
}

// Подставляет {prompt} и {seed} в шаблон тела запроса.
function fillTemplate(node, prompt, seed) {
  if (typeof node === "string") {
    if (node === "{seed}") return seed;
    return node.replace(/\{prompt\}/g, prompt).replace(/\{seed\}/g, String(seed));
  }
  if (Array.isArray(node)) return node.map((x) => fillTemplate(x, prompt, seed));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = fillTemplate(v, prompt, seed);
    return out;
  }
  return node;
}

// Встроенные Cloudflare/NVIDIA/OpenRouter + добавленные пользователем
export function getAllProviders(env) {
  // Порядок = приоритет: Cloudflare (бесплатно), затем NVIDIA,
  // затем OpenRouter и пользовательские API. Gemini для картинок скрыт:
  // по просьбе пользователя Gemini оставляем только для текста.
  // disabled — модели, отключённые по качеству. Секрет SHOW_ALL_MODELS=1
  // возвращает их обратно, если понадобится сравнить.
  const showAll = env && String(env.SHOW_ALL_MODELS || "") === "1";

  return [
    ...getCfProviders(env),
    ...NIM_PROVIDERS,
    ...getOpenRouterProviders(env),
    ...getCustomProviders(env),
  ].filter((p) => showAll || !p.disabled);
}

/**
 * Cloudflare Workers AI — БЕСПЛАТНО 10 000 нейронов в сутки.
 * Ключ не нужен: бот уже работает на Cloudflare, доступ идёт через
 * binding env.AI (добавляется в wrangler.toml секцией [ai]).
 * Сброс лимита ежедневно в 00:00 UTC.
 */
export const CF_PROVIDERS = [
  {
    id: "cf-flux",
    title: "FLUX.1 schnell (Cloudflare, бесплатно)",
    binding: true,
    model: "@cf/black-forest-labs/flux-1-schnell",
    build: (prompt, seed) => ({ prompt, seed, steps: 4 }),
  },
  {
    // Отключена: по голосам в /models рейтинг 0% (0 лайков на 15 постов).
    // Остаётся в файле, чтобы можно было вернуть, но в пул не попадает.
    disabled: true,
    id: "cf-sdxl",
    title: "SDXL Lightning (Cloudflare, бесплатно)",
    binding: true,
    model: "@cf/bytedance/stable-diffusion-xl-lightning",
    // Lightning — дистиллированная модель: ей нужны НИЗКИЙ guidance (1-2)
    // и мало шагов. С дефолтными guidance 7.5 / num_steps 20 она
    // пережаривает картинку — отсюда «уровень 2022 года».
    build: (prompt, seed, negative) => ({
      prompt,
      negative_prompt: negative || undefined,
      guidance: 1.5,
      num_steps: 8,
      width: 1024,
      height: 1024,
      seed,
    }),
  },
  {
    id: "cf-dreamshaper",
    title: "DreamShaper 8 (Cloudflare, бесплатно)",
    binding: true,
    model: "@cf/lykon/dreamshaper-8-lcm",
    // LCM-модель: рекомендованный CFG ~2, шагов 5-8.
    build: (prompt, seed, negative) => ({
      prompt,
      negative_prompt: negative || undefined,
      guidance: 2,
      num_steps: 8,
      width: 768,
      height: 768,
      seed,
    }),
  },
];


/**
 * Google Gemini («Nano Banana») — качество на уровне современных ИИ.
 * Бесплатный тариф в AI Studio, карта не нужна: aistudio.google.com/apikey
 * Ключ кладётся в секрет GEMINI_API_KEY.
 *
 * Формат ответа отличается от остальных: картинка лежит в
 * candidates[0].content.parts[].inlineData.data (base64).
 */
const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-3.6";
const DEFAULT_GEMINI_IMAGE_MODELS = [
  "gemini-3.6",
  "gemini-2.5-flash-image-preview",
  "gemini-2.5-flash-image",
];
const GEMINI_PRO_IMAGE_MODEL = "gemini-3-pro-image-preview";

export function getGeminiImageModels(env) {
  const raw = env?.GEMINI_IMAGE_MODELS || env?.GEMINI_IMAGE_MODEL || "";
  const configured = String(raw)
    .split(/[,\s]+/)
    .map((m) => m.trim().replace(/^models\//, ""))
    .filter(Boolean);
  const allowPaid = String(env?.GEMINI_PRO || "") === "1";
  const models = [
    ...configured,
    ...DEFAULT_GEMINI_IMAGE_MODELS,
    DEFAULT_GEMINI_IMAGE_MODEL,
    ...(allowPaid ? [GEMINI_PRO_IMAGE_MODEL] : []),
  ];
  return [...new Set(models)];
}

function geminiImagePrompt(prompt, negative = "") {
  const avoid = [
    "readable text", "captions", "watermarks", "logos", "NSFW", "nudity",
    String(negative || ""),
  ].filter(Boolean).join(", ");

  return [
    "Generate one square safe-for-work image.",
    `Main scene, subject and action that MUST be followed exactly: ${prompt}`,
    "Do not replace the requested subject with a generic morning scene.",
    "Keep the composition simple and focused on the requested subject.",
    avoid ? `Avoid: ${avoid}.` : "",
  ].filter(Boolean).join("\n");
}

function suggestedGeminiImageModels(errorText) {
  const out = [];
  const re = /models\/([a-zA-Z0-9_.-]+)/g;
  let m;
  while ((m = re.exec(String(errorText || "")))) out.push(m[1]);
  return [...new Set(out)];
}

function geminiImageTitle(model) {
  if (model.includes("3.6")) return "Gemini 3.6 Image";
  if (model.includes("3-pro")) return "Gemini 3 Pro Image (лучшее качество, может быть платным)";
  if (model.includes("preview")) return "Gemini 2.5 Flash Image Preview";
  return "Gemini Image";
}

function geminiImageProvider(model, index) {
  // id gemini-image оставляем для обратной совместимости с уже выбранной
  // вручную моделью в настройках чатов.
  const id = index === 0 ? "gemini-image" : `gemini-image-${model.replace(/[^a-z0-9]+/gi, "-")}`;
  return {
    id,
    title: geminiImageTitle(model),
    gemini: true,
    model,
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    keyEnv: "GEMINI_API_KEY",
    // ВАЖНО: у Flash Image в примерах Google стоит TEXT + IMAGE.
    // С одним лишь ["IMAGE"] она может отвечать 400 «does not support the
    // requested response modalities». Картинку берём из inlineData,
    // текстовую часть просто игнорируем.
    build: (prompt, seed, negative) => ({
      contents: [{ parts: [{ text: geminiImagePrompt(prompt, negative) }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    }),
  };
}

export const GEMINI_PROVIDERS = [];

function getGeminiProviders(env) {
  // Gemini используется только для текстовых подписей. Для картинок он не
  // показывается в /models и не участвует в auto/fallback, чтобы случайно не
  // тратить квоту/деньги и не путать его с Cloudflare-моделями.
  return [];
}

const DEFAULT_OPENROUTER_IMAGE_MODEL = "openrouter/free";
const DEFAULT_OPENROUTER_IMAGE_DAILY_LIMIT = 20;

function hashText(text) {
  let value = 2166136261;
  const str = String(text || "");
  for (let i = 0; i < str.length; i++) {
    value ^= str.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(36);
}

function openRouterModelBadKey(model) {
  return `openrouter:image:bad:${hashText(model)}`;
}

async function isOpenRouterModelBad(env, model) {
  if (!env?.BOT_KV || !model) return false;
  return Boolean(await env.BOT_KV.get(openRouterModelBadKey(model)));
}

export async function markOpenRouterImageModelBad(env, model, reason = "bad", ttl = 14 * 86400) {
  if (!env?.BOT_KV || !model) return;
  await env.BOT_KV.put(openRouterModelBadKey(model), String(reason || "bad").slice(0, 120), {
    expirationTtl: ttl,
  });
}

export function openRouterModelFromTitle(title) {
  const text = String(title || "").trim();
  if (!text.toLowerCase().includes("openrouter")) return "";
  const parts = text.split(/\s+[—-]\s+/);
  return (parts[parts.length - 1] || "").trim();
}

export function getOpenRouterImageModels(env) {
  const raw = env?.OPENROUTER_IMAGE_MODELS || env?.OPENROUTER_IMAGE_MODEL || "";
  const configured = String(raw)
    .split(/[,\s]+/)
    .map((m) => m.trim())
    .filter(Boolean);
  return [...new Set([...configured, DEFAULT_OPENROUTER_IMAGE_MODEL])];
}

function isFreeOpenRouterModel(model) {
  const m = String(model || "").toLowerCase();
  return m === "openrouter/free" || m.endsWith(":free");
}

function openRouterTitle(model) {
  const free = isFreeOpenRouterModel(model) ? " бесплатная" : "";
  if (model.includes("seedream")) return "OpenRouter Seedream Image" + free;
  if (model.includes("gemini")) return "OpenRouter Gemini Image" + free;
  if (model.includes("gpt-image")) return "OpenRouter GPT Image" + free;
  return "OpenRouter Image" + free;
}

function openRouterProvider(model, index, env) {
  const resolution = String(env?.OPENROUTER_IMAGE_RESOLUTION || "1K");
  const quality = String(env?.OPENROUTER_IMAGE_QUALITY || "auto");
  return {
    id: index === 0 ? "openrouter-image" : `openrouter-image-${model.replace(/[^a-z0-9]+/gi, "-")}`,
    title: `${openRouterTitle(model)} — ${model}`,
    openrouter: true,
    model,
    url: "https://openrouter.ai/api/v1/images",
    keyEnv: "OPENROUTER_API_KEY",
    build: (prompt, seed, negative) => ({
      model,
      prompt: [
        `Create exactly this safe-for-work image: ${prompt}`,
        "The requested subject and action are mandatory; do not replace them with a generic morning scene.",
        negative ? `Avoid: ${negative}.` : "",
      ].filter(Boolean).join("\n"),
      aspect_ratio: "1:1",
      resolution,
      quality,
      output_format: "png",
    }),
  };
}

function getOpenRouterProviders(env) {
  // OpenRouter для картинок скрыт: у free-роута фактически нет бесплатной
  // генерации изображений. Код оставляем как задел, но в /models и auto он
  // не попадает, даже если OPENROUTER_API_KEY задан.
  return [];
}

function openRouterHeaders(env) {
  const headers = {
    Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (env.OPENROUTER_SITE_URL) headers["HTTP-Referer"] = String(env.OPENROUTER_SITE_URL);
  if (env.OPENROUTER_APP_NAME) headers["X-Title"] = String(env.OPENROUTER_APP_NAME);
  return headers;
}

function looksLikeImageModel(model, fromImageEndpoint = false) {
  if (fromImageEndpoint) return true;
  const values = [
    ...(model?.architecture?.output_modalities || []),
    ...(model?.architecture?.input_modalities || []),
    ...(model?.modalities || []),
    ...(model?.output_modalities || []),
    ...(model?.supported_parameters || []),
  ].map((v) => String(v).toLowerCase());
  return values.some((v) => v.includes("image"));
}

function isFreeOpenRouterRecord(model) {
  const id = String(model?.id || model?.slug || "");
  if (isFreeOpenRouterModel(id)) return true;
  const p = model?.pricing || {};
  const nums = [p.prompt, p.completion, p.image, p.request]
    .filter((v) => v !== undefined && v !== null)
    .map(Number);
  return nums.length > 0 && nums.every((n) => Number.isFinite(n) && n === 0);
}

function extractOpenRouterModels(payload, fromImageEndpoint = false) {
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return list
    .filter((m) => m && (m.id || m.slug))
    .filter((m) => isFreeOpenRouterRecord(m) && looksLikeImageModel(m, fromImageEndpoint))
    .map((m) => String(m.id || m.slug).trim())
    .filter(Boolean);
}

async function discoverOpenRouterFreeImageModels(env) {
  if (!env?.OPENROUTER_API_KEY || !env?.BOT_KV) return [];
  const cacheKey = "openrouter:image:models:v2";
  try {
    const cached = await env.BOT_KV.get(cacheKey, "json");
    if (Array.isArray(cached) && cached.length) return cached;
  } catch {}

  const headers = openRouterHeaders(env);
  const out = [];
  for (const [url, imageEndpoint] of [
    ["https://openrouter.ai/api/v1/images/models", true],
    ["https://openrouter.ai/api/v1/models", false],
  ]) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      out.push(...extractOpenRouterModels(await res.json(), imageEndpoint));
    } catch {}
  }

  const unique = [...new Set(out)];
  if (unique.length) {
    try { await env.BOT_KV.put(cacheKey, JSON.stringify(unique), { expirationTtl: 6 * 3600 }); } catch {}
  }
  return unique;
}

async function openRouterCandidateModels(env, configuredModel) {
  const configured = String(configuredModel || DEFAULT_OPENROUTER_IMAGE_MODEL).trim();
  const discovered = await discoverOpenRouterFreeImageModels(env);
  const raw = configured === "openrouter/free"
    ? [...discovered, configured]
    : [configured, ...discovered];
  const unique = [...new Set(raw)].filter(Boolean);
  const good = [];
  for (const model of unique) {
    if (!(await isOpenRouterModelBad(env, model))) good.push(model);
  }
  return good.length ? good : unique;
}

function openRouterSearchTimeout(env) {
  const n = Number(env?.OPENROUTER_IMAGE_SEARCH_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 60000) : 55000;
}

function openRouterMaxCandidates(env) {
  const n = Number(env?.OPENROUTER_IMAGE_MAX_CANDIDATES);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10) : 3;
}

function openRouterLimit(env) {
  const n = Number(env?.OPENROUTER_IMAGE_DAILY_LIMIT);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_OPENROUTER_IMAGE_DAILY_LIMIT;
}

function openRouterDayKey() {
  return `openrouter:image:${new Date().toISOString().slice(0, 10)}`;
}

async function reserveOpenRouterImageCall(env) {
  const limit = openRouterLimit(env);
  if (!limit) return { ok: false, count: 0, limit };
  if (!env?.BOT_KV) return { ok: true, count: 0, limit };

  const key = openRouterDayKey();
  const count = Number(await env.BOT_KV.get(key)) || 0;
  if (count >= limit) return { ok: false, count, limit };
  const next = count + 1;
  await env.BOT_KV.put(key, String(next), { expirationTtl: 2 * 86400 });
  await addUsage(env, 0, "openrouter_image");
  return { ok: true, count: next, limit };
}


// Доступны, только если в wrangler.toml подключён binding [ai]
function getCfProviders(env) {
  return env && env.AI ? CF_PROVIDERS : [];
}


export function getProvider(id, env = null) {
  const list = env ? getAllProviders(env) : NIM_PROVIDERS;
  return list.find((p) => p.id === id) || null;
}

function extractBase64(payload) {
  if (!payload) return null;

  const clean = (value) => {
    if (typeof value !== "string" || value.length < 100) return null;
    return value.startsWith("data:") && value.includes(",")
      ? value.slice(value.indexOf(",") + 1)
      : value;
  };

  const candidates = [
    payload.image,
    payload.b64_json,
    payload.artifacts?.[0]?.base64,
    payload.artifacts?.[0]?.b64_json,
    payload.images?.[0],
    payload.images?.[0]?.base64,
    payload.data?.[0]?.b64_json,
    payload.data?.[0]?.image,
    payload.output?.[0],
  ];

  for (const candidate of candidates) {
    const value = clean(candidate);
    if (value) return value;
  }

  return null;
}

function extractUrl(payload) {
  return payload?.data?.[0]?.url || payload?.artifacts?.[0]?.url || null;
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function callProvider(provider, prompt, env, apiKey, negative = "") {
  const seed = Math.floor(Math.random() * 2 ** 31);
  const started = Date.now();

  // Google Gemini — заголовок x-goog-api-key и особый формат ответа.
  if (provider.gemini) {
    const key = env[provider.keyEnv];
    if (!key) {
      return { ok: false, status: 0, latency: 0,
               error: `Не задан секрет ${provider.keyEnv}` };
    }

    const response = await fetch(provider.url, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(provider.build(prompt, seed, negative)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const latency = Date.now() - started;

    if (!response.ok) {
      const body = await response.text();
      return { ok: false, status: response.status, latency, error: body.slice(0, 300) };
    }

    const data = await response.json();
    // Картинка лежит в parts[].inlineData.data
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const inline = parts.find((p) => p?.inlineData?.data)?.inlineData?.data;

    if (inline) {
      // У Gemini свой лимит (не нейроны) — считаем запросы отдельно.
      await addUsage(env, 0, "gemini_image");
      return { ok: true, status: 200, latency, bytes: base64ToBytes(inline), seed };
    }

    // Модель могла ответить текстом вместо картинки (например, отказ)
    const textPart = parts.find((p) => p?.text)?.text;
    return {
      ok: false, status: response.status, latency,
      error: textPart
        ? "Gemini вернул текст вместо картинки: " + String(textPart).slice(0, 200)
        : "Gemini: нет изображения в ответе",
    };
  }


  // OpenRouter Image API — отдельный ключ и отдельный endpoint /api/v1/images.
  if (provider.openrouter) {
    const key = env[provider.keyEnv || "OPENROUTER_API_KEY"];
    if (!key) {
      return { ok: false, status: 0, latency: 0,
               error: `Не задан секрет ${provider.keyEnv || "OPENROUTER_API_KEY"}` };
    }

    const deadline = Date.now() + openRouterSearchTimeout(env);
    const candidates = (await openRouterCandidateModels(env, provider.model))
      .slice(0, openRouterMaxCandidates(env));
    const errors = [];

    for (const model of candidates) {
      const left = deadline - Date.now();
      if (left <= 1000) break;

      const quota = await reserveOpenRouterImageCall(env);
      if (!quota.ok) {
        return {
          ok: false,
          status: 429,
          latency: Date.now() - started,
          error: `OpenRouter дневной лимит ${quota.count}/${quota.limit} запросов исчерпан`,
        };
      }

      const response = await fetch(provider.url, {
        method: "POST",
        headers: openRouterHeaders(env),
        body: JSON.stringify({ ...provider.build(prompt, seed, negative), model }),
        signal: AbortSignal.timeout(Math.min(left, 60000)),
      }).catch((e) => ({ timeoutError: e }));

      const latency = Date.now() - started;
      if (response.timeoutError) {
        return {
          ok: false,
          status: 408,
          latency,
          error: `OpenRouter не нашёл рабочую модель за ${Math.round(openRouterSearchTimeout(env) / 1000)} сек: ${String(response.timeoutError?.message || response.timeoutError).slice(0, 120)}`,
        };
      }

      if (!response.ok) {
        const body = await response.text();
        const err = body.slice(0, 300);
        errors.push(`${model}: ${err.slice(0, 120)}`);
        if ([400, 404, 410, 422].includes(response.status) || /no endpoints|unsupported|not support|model.*not|does not support|image.*not/i.test(err)) {
          await markOpenRouterImageModelBad(env, model, err, 24 * 3600).catch(() => null);
          continue;
        }
        return { ok: false, status: response.status, latency, error: err };
      }

      const payload = await response.json();
      const base64 = extractBase64(payload);
      if (base64) {
        return {
          ok: true,
          status: 200,
          latency,
          bytes: base64ToBytes(base64),
          seed,
          model,
          modelTitle: `${openRouterTitle(model)} — ${model}`,
        };
      }
      const url = extractUrl(payload);
      if (url) {
        const imageResponse = await fetch(url, { signal: AbortSignal.timeout(Math.min(deadline - Date.now(), 15000)) }).catch(() => null);
        if (imageResponse?.ok) {
          return {
            ok: true,
            status: 200,
            latency: Date.now() - started,
            bytes: new Uint8Array(await imageResponse.arrayBuffer()),
            seed,
            model,
            modelTitle: `${openRouterTitle(model)} — ${model}`,
          };
        }
      }

      const err = "нет изображения в ответе: " + JSON.stringify(payload).slice(0, 180);
      errors.push(`${model}: ${err}`);
      await markOpenRouterImageModelBad(env, model, err, 24 * 3600).catch(() => null);
    }

    return {
      ok: false,
      status: 0,
      latency: Date.now() - started,
      error: errors.length
        ? "OpenRouter: не нашёл рабочую free image модель: " + errors.slice(0, 3).join("; ")
        : "OpenRouter: нет доступных free image моделей",
    };
  }

  // Cloudflare Workers AI — через binding, без ключа и без fetch.
  if (provider.binding) {
    try {
      const out = await env.AI.run(
        provider.model,
        provider.build(prompt, seed, negative)
      );
      const b64 = out?.image || (typeof out === "string" ? out : null);

      if (b64) {
        // Считаем расход нейронов для /usage
        await addUsage(env, estimateImageNeurons(provider.model), "image");
        return { ok: true, status: 200, latency: Date.now() - started,
                 bytes: base64ToBytes(b64), seed };
      }
      // некоторые модели отдают поток байтов
      if (out instanceof ReadableStream) {
        const buf = await new Response(out).arrayBuffer();
        await addUsage(env, estimateImageNeurons(provider.model), "image");
        return { ok: true, status: 200, latency: Date.now() - started,
                 bytes: new Uint8Array(buf), seed };
      }
      return { ok: false, status: 0, latency: Date.now() - started,
               error: "Workers AI: нет изображения в ответе" };
    } catch (e) {
      const msg = String(e?.message || e);
      return {
        ok: false, status: /limit|quota|exceed/i.test(msg) ? 429 : 0,
        latency: Date.now() - started, error: msg.slice(0, 250),
      };
    }
  }

  // У своего провайдера — свой ключ (имя переменной задано в keyEnv)
  // и свой способ авторизации.
  const key = provider.custom && provider.keyEnv ? env[provider.keyEnv] : apiKey;

  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  if (provider.custom && provider.authHeader === "x-api-key") {
    headers["x-api-key"] = key;
  } else if (provider.custom && provider.authHeader === "none") {
    // без авторизации
  } else {
    headers.Authorization = `Bearer ${key}`;
  }

  const response = await fetch(provider.url, {
    method: "POST",
    headers,
    body: JSON.stringify(provider.build(prompt, seed)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const latency = Date.now() - started;

  // format: "raw" — сервис отдаёт сами байты картинки, а не JSON
  if (provider.custom && provider.format === "raw") {
    if (!response.ok) {
      const body = await response.text();
      return { ok: false, status: response.status, latency, error: body.slice(0, 300) };
    }
    return {
      ok: true,
      status: 200,
      latency,
      bytes: new Uint8Array(await response.arrayBuffer()),
      seed,
    };
  }

  if (!response.ok) {
    const body = await response.text();
    return { ok: false, status: response.status, latency, error: body.slice(0, 300) };
  }

  const payload = await response.json();
  const base64 = extractBase64(payload);

  if (base64) {
    // Учитываем запрос к NVIDIA отдельно от Cloudflare
    if (!provider.custom && !provider.binding) await addUsage(env, 0, "nvidia");
    return { ok: true, status: 200, latency, bytes: base64ToBytes(base64), seed };
  }

  const url = extractUrl(payload);

  if (url) {
    const imageResponse = await fetch(url);
    if (imageResponse.ok) {
      return {
        ok: true,
        status: 200,
        latency: Date.now() - started,
        bytes: new Uint8Array(await imageResponse.arrayBuffer()),
        seed,
      };
    }
  }

  return {
    ok: false,
    status: response.status,
    latency,
    error: "Нет изображения в ответе: " + JSON.stringify(payload).slice(0, 200),
  };
}

async function isCoolingDown(id, env) {
  return Boolean(await env.BOT_KV.get(`nimfail:${id}`));
}

function markFailed(id, env, status = 0, error = "") {
  // Брак генерации (чёрный кадр) — разовый сбой, а не поломка модели.
  // Гасить её на 30 минут незачем: следующий запрос обычно нормальный.
  if (String(error).startsWith("брак генерации")) return;

  // 400/422 часто бывают плохим промптом, но у агрегаторов вроде OpenRouter
  // это ещё и «у модели нет image endpoint / unsupported». Такие ошибки тоже
  // стоит ненадолго гасить, иначе auto будет долбить заведомо нерабочую модель.
  const permanentModelError = /no endpoints|unsupported|not support|model.*not|does not support|image.*not/i.test(String(error || ""));
  if ((status === 400 || status === 422) && !permanentModelError) return;
  const ttl = status === 429 || status >= 500 || permanentModelError ? FAIL_COOLDOWN : 5 * 60;
  return env.BOT_KV.put(`nimfail:${id}`, "1", { expirationTtl: ttl });
}

export async function generateImage(prompt, env, options = {}) {
  const {
    preferred = "auto",
    chatId = null,
    noFallback = false,
    negative = "",
  } = options;

  // Пустой промпт — модели вернут мусор или ошибку. Отсекаем сразу.
  if (!String(prompt || "").trim()) {
    return {
      ok: false,
      attempts: [{ provider: "-", ok: false, status: 0, latency: 0,
                   error: "Пустой промпт. Добавьте его: /add_prompt weekday <текст>" }],
    };
  }

  const keys = getApiKeys(env);
  const hasCustom = getCustomProviders(env).length > 0 ||
    getCfProviders(env).length > 0 || getOpenRouterProviders(env).length > 0;

  // Ключи NVIDIA не обязательны, если добавлен свой провайдер со своим ключом.
  if (!keys.length && !hasCustom) {
    return {
      ok: false,
      attempts: [{ provider: "-", ok: false, status: 0, latency: 0,
                   error: "Нет доступных провайдеров. Задайте GEMINI_API_KEY, включите Workers AI ([ai] в wrangler.toml) или задайте NVIDIA_API_KEY" }]
    };
  }
  let keyIndex = keys.length ? await pickKeyIndex(keys, env) : 0;

  // Встроенные NVIDIA + добавленные секретом IMAGE_PROVIDERS_JSON
  const all = getAllProviders(env);

  let queue;

  // Модель, выбранную человеком вручную, cooldown пропускать не должен:
  // иначе он ставит галочку на Модель 2, а картинки идут с другой.
  let pinnedId = null;

  if (preferred !== "auto" && getProvider(preferred, env)) {
    const pinned = getProvider(preferred, env);
    pinnedId = pinned.id;

    // Если человек выбрал конкретную модель, не подменяем её молча другой.
    // Раньше выбранный Gemini падал, после чего бот доходил до Cloudflare
    // DreamShaper — в отчёте выглядело так, будто «Gemini использует
    // DreamShaper». Теперь ручной выбор означает строгий выбор.
    // Исключение: для Gemini можно перебрать только другие Gemini-image id
    // из GEMINI_IMAGE_MODELS, но не уходить в Cloudflare/NVIDIA.
    if (noFallback) {
      queue = [pinned];
    } else if (pinned.gemini) {
      queue = [pinned, ...all.filter((p) => p.gemini && p.id !== pinned.id)];
    } else if (String(env.IMAGE_PINNED_FALLBACK || "") === "1") {
      queue = [pinned, ...all.filter((p) => p.id !== pinned.id)];
    } else {
      queue = [pinned];
    }
  } else {
    // ПРИОРИТЕТ: Cloudflare (бесплатно), затем NVIDIA и пользовательские API.
    // OpenRouter для картинок скрыт и в auto не участвует.
    const CF_QUALITY = ["cf-flux", "cf-dreamshaper", "cf-sdxl"];
    const cf = getCfProviders(env)
      .slice()
      .sort((a, b) => CF_QUALITY.indexOf(a.id) - CF_QUALITY.indexOf(b.id));

    const rest = all.filter((p) =>
      !p.binding && !p.gemini && !p.openrouter && (p.custom || keys.length > 0)
    );

    const shuffle = (arr) => {
      if (!arr.length) return [];
      const off = Math.floor(Math.random() * arr.length);
      return [...arr.slice(off), ...arr.slice(0, off)];
    };

    queue = [...cf, ...shuffle(rest)];
  }

  const attempts = [];

  if (!queue.length) {
    return {
      ok: false,
      attempts: [{
        provider: "-",
        ok: false,
        status: 0,
        latency: 0,
        error: "В авто-режиме нет доступных провайдеров. Включите Workers AI ([ai] в wrangler.toml), задайте NVIDIA_API_KEY или добавьте свой IMAGE_PROVIDERS_JSON.",
      }],
    };
  }

  for (const provider of queue) {
    // Закреплённую вручную модель пробуем всегда, даже после сбоя.
    if (provider.id !== pinnedId && (await isCoolingDown(provider.id, env))) {
      // Это не запрос к модели, а локальный пропуск по cooldown. Не пишем его
      // в attempts/gen_log, иначе статистика «сбоев» раздувается: один
      // реальный 429 превращается в десятки псевдо-сбоев.
      continue;
    }

    let result;

    try {
      result = await callProvider(provider, prompt, env, keys[keyIndex] || null, negative);


      // Ключ упёрся в лимит или протух — пробуем следующий на этой же модели.
      if (!provider.custom && !provider.binding && !provider.gemini && !result.ok && [401, 403, 429].includes(result.status) && keys.length > 1) {
        await markKeyFailed(keyIndex, env, result.status);
        const nextIndex = (keyIndex + 1) % keys.length;
        if (nextIndex !== keyIndex) {
          keyIndex = nextIndex;
          result = await callProvider(provider, prompt, env, keys[keyIndex], negative);
        }
      }
    } catch (error) {
      result = { ok: false, status: 0, latency: 0, error: String(error).slice(0, 300) };
    }

    // Модель могла вернуть «успех» с чёрным или однотонным кадром:
    // сработал safety-фильтр либо свалился декодер. Байты есть,
    // статус 200 — а в чат уходил пустой прямоугольник.
    if (result.ok && result.bytes) {
      const badImage = imageProblem(result.bytes);
      if (badImage) {
        result = {
          ok: false,
          status: result.status,
          latency: result.latency,
          error: "брак генерации: " + badImage,
        };
      }
    }

    attempts.push({
      provider: provider.id,
      ok: result.ok,
      status: result.status,
      latency: result.latency,
      error: result.error,
    });

    // Если Gemini вернул 404 с подсказкой «use models/...», добавляем
    // подсказанную модель сразу следующей в очередь. Так новые model id
    // можно подхватывать без срочного релиза.
    if (provider.gemini && !result.ok && result.error) {
      for (const suggested of suggestedGeminiImageModels(result.error)) {
        const alreadyQueued = queue.some((p) => p.gemini && p.model === suggested);
        if (!alreadyQueued) queue.splice(queue.indexOf(provider) + 1, 0, geminiImageProvider(suggested, queue.length));
      }
    }

    if (result.ok) {
      return {
        ok: true,
        bytes: result.bytes,
        provider: provider.id,
        model: result.modelTitle || provider.title,
        latency: result.latency,
        seed: result.seed,
        keyIndex: keyIndex + 1,
        keyCount: keys.length,
        attempts,
      };
    }

    // noFallback = это /nim_health, то есть диагностика. Она не должна
    // загонять модели в кулдаун: иначе сама проверка выключает половину
    // пула на 5-30 минут, и следующая генерация идёт мимо рабочих моделей.
    if (!noFallback) {
      await markFailed(provider.id, env, result.status, result.error);
    }
  }

  return { ok: false, attempts };
}
