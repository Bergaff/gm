import { addUsage, estimateImageNeurons } from "../usage.js";

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
    id: "sdxl",
    title: "Stable Diffusion XL",
    url: `${BASE}/stabilityai/stable-diffusion-xl`,
    build: (prompt, seed) => ({
      text_prompts: [{ text: prompt, weight: 1 }],
      cfg_scale: 5, sampler: "K_DPM_2_ANCESTRAL", seed, steps: 25,
    }),
  },
  {
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

// Встроенные NVIDIA + добавленные пользователем
export function getAllProviders(env) {
  // Порядок = приоритет: Gemini (лучшее качество, свой бесплатный лимит),
  // затем Cloudflare (бесплатно), затем NVIDIA и свои провайдеры.
  return [
    ...getGeminiProviders(env),
    ...getCfProviders(env),
    ...NIM_PROVIDERS,
    ...getCustomProviders(env),
  ];
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
    id: "cf-sdxl",
    title: "SDXL Lightning (Cloudflare, бесплатно)",
    binding: true,
    model: "@cf/bytedance/stable-diffusion-xl-lightning",
    build: (prompt) => ({ prompt }),
  },
  {
    id: "cf-dreamshaper",
    title: "DreamShaper 8 (Cloudflare, бесплатно)",
    binding: true,
    model: "@cf/lykon/dreamshaper-8-lcm",
    build: (prompt) => ({ prompt }),
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
export const GEMINI_PROVIDERS = [
  {
    // Gemini 3 Pro Image — ЕДИНСТВЕННАЯ модель, официально поддерживающая
    // русский язык (ru-RU) и заметно лучше рисующая текст на картинке.
    // Документация Google: 2.5 Flash поддерживает только EN, es-MX, ja, zh, hi.
    id: "gemini-3-pro",
    title: "Gemini 3 Pro Image (лучшее качество, знает русский)",
    gemini: true,
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent",
    keyEnv: "GEMINI_API_KEY",
    build: (prompt) => ({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  },
  {
    id: "gemini-image",
    title: "Gemini 2.5 Flash Image (быстрее, только английский)",
    gemini: true,
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent",
    keyEnv: "GEMINI_API_KEY",
    build: (prompt) => ({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  },
];

function getGeminiProviders(env) {
  return env && env.GEMINI_API_KEY ? GEMINI_PROVIDERS : [];
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

async function callProvider(provider, prompt, env, apiKey) {
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
      body: JSON.stringify(provider.build(prompt, seed)),
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
      await addUsage(env, 0, "gemini");
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


  // Cloudflare Workers AI — через binding, без ключа и без fetch.
  if (provider.binding) {
    try {
      const out = await env.AI.run(provider.model, provider.build(prompt, seed));
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

function markFailed(id, env, status = 0) {
  // 400/422 — это плохой запрос (например, промпт), повтор через 30 минут
  // ничего не изменит и зря выключает рабочую модель. 401/403/429 и 5xx —
  // временные/квотные, их гасим на полный срок.
  if (status === 400 || status === 422) return;
  const ttl = status === 429 || status >= 500 ? FAIL_COOLDOWN : 5 * 60;
  return env.BOT_KV.put(`nimfail:${id}`, "1", { expirationTtl: ttl });
}

export async function generateImage(prompt, env, options = {}) {
  const { preferred = "auto", chatId = null, noFallback = false } = options;

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
    getCfProviders(env).length > 0 || getGeminiProviders(env).length > 0;

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

  if (preferred !== "auto" && getProvider(preferred, env)) {
    const pinned = getProvider(preferred, env);
    // noFallback: только запрошенная модель (нужно для /nim_health,
    // иначе перебор всех моделей упирается в лимит субреквестов).
    queue = noFallback
      ? [pinned]
      : [pinned, ...all.filter((p) => p.id !== pinned.id)];
  } else {
    // ПРИОРИТЕТ: сначала бесплатный Cloudflare (в случайном порядке между
    // своими моделями), и только если ВСЕ они не сработали — платные NVIDIA
    // и добавленные провайдеры. Раньше очередь тасовалась целиком, и первым
    // мог оказаться NVIDIA, зря тративший кредиты.
    const cf = getCfProviders(env);
    const rest = all.filter((p) => !p.binding);

    const shuffle = (arr) => {
      if (!arr.length) return [];
      const off = Math.floor(Math.random() * arr.length);
      return [...arr.slice(off), ...arr.slice(0, off)];
    };

    queue = [...shuffle(cf), ...shuffle(rest)];
  }

  const attempts = [];

  for (const provider of queue) {
    if (await isCoolingDown(provider.id, env)) {
      attempts.push({
        provider: provider.id, ok: false, status: 0, latency: 0,
        error: "cooldown после недавней ошибки",
      });
      continue;
    }

    let result;

    try {
      result = await callProvider(provider, prompt, env, keys[keyIndex] || null);

      // Ключ упёрся в лимит или протух — пробуем следующий на этой же модели.
      if (!provider.custom && !provider.binding && !provider.gemini && !result.ok && [401, 403, 429].includes(result.status) && keys.length > 1) {
        await markKeyFailed(keyIndex, env, result.status);
        const nextIndex = (keyIndex + 1) % keys.length;
        if (nextIndex !== keyIndex) {
          keyIndex = nextIndex;
          result = await callProvider(provider, prompt, env, keys[keyIndex]);
        }
      }
    } catch (error) {
      result = { ok: false, status: 0, latency: 0, error: String(error).slice(0, 300) };
    }

    attempts.push({
      provider: provider.id,
      ok: result.ok,
      status: result.status,
      latency: result.latency,
      error: result.error,
    });

    if (result.ok) {
      return {
        ok: true,
        bytes: result.bytes,
        provider: provider.id,
        model: provider.title,
        latency: result.latency,
        seed: result.seed,
        keyIndex: keyIndex + 1,
        keyCount: keys.length,
        attempts,
      };
    }

    await markFailed(provider.id, env, result.status);
  }

  return { ok: false, attempts };
}
