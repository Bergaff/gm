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

export function getProvider(id) {
  return NIM_PROVIDERS.find((p) => p.id === id) || null;
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

  const response = await fetch(provider.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(provider.build(prompt, seed)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const latency = Date.now() - started;

  if (!response.ok) {
    const body = await response.text();
    return { ok: false, status: response.status, latency, error: body.slice(0, 300) };
  }

  const payload = await response.json();
  const base64 = extractBase64(payload);

  if (base64) {
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

  const keys = getApiKeys(env);
  if (!keys.length) {
    return {
      ok: false,
      attempts: [{ provider: "-", ok: false, status: 0, latency: 0,
                   error: "Не задан ни один ключ NVIDIA (NVIDIA_API_KEY)" }],
    };
  }
  let keyIndex = await pickKeyIndex(keys, env);

  let queue;

  if (preferred !== "auto" && getProvider(preferred)) {
    const pinned = getProvider(preferred);
    // noFallback: только запрошенная модель (нужно для /nim_health,
    // иначе 7 моделей x 7 попыток = до 49 субреквестов при лимите 50).
    queue = noFallback
      ? [pinned]
      : [pinned, ...NIM_PROVIDERS.filter((p) => p.id !== pinned.id)];
  } else {
    const offset = Math.floor(Math.random() * NIM_PROVIDERS.length);
    queue = [...NIM_PROVIDERS.slice(offset), ...NIM_PROVIDERS.slice(0, offset)];
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
      result = await callProvider(provider, prompt, env, keys[keyIndex]);

      // Ключ упёрся в лимит или протух — пробуем следующий на этой же модели.
      if (!result.ok && [401, 403, 429].includes(result.status) && keys.length > 1) {
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
