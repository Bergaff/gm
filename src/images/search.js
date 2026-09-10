const CACHE_TTL = 6 * 60 * 60;
const RECENT_TTL = 90 * 24 * 60 * 60;
const MAX_IMAGE_BYTES = 9.5 * 1024 * 1024;
const TIMEOUT_MS = 12000;

const SAFE_WORDS = [
  "porn", "porno", "xxx", "sex", "nude", "nudity", "naked", "erotic", "hentai", "nsfw",
  "порно", "секс", "эротик", "голая", "голый", "обнажен", "обнажён", "интим",
];

function hash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(36);
}

function normalizeQuery(query) {
  return String(query || "").trim().replace(/\s+/g, " ").slice(0, 120);
}

function unsafe(result) {
  const text = [result.title, result.link, result.contextLink].join(" ").toLowerCase();
  return SAFE_WORDS.some((w) => text.includes(w));
}

function imageLike(result) {
  const mime = String(result.mime || result.contentType || "").toLowerCase();
  const link = String(result.link || "").toLowerCase();
  if (mime && !mime.startsWith("image/")) return false;
  if (mime === "image/gif") return false;
  if (/\.(gif|svg)(\?|#|$)/i.test(link)) return false;
  return /^https?:\/\//i.test(result.link || "") && !unsafe(result);
}

function unique(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const key = r.link;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function googleSearch(query, env, force = false) {
  const key = env.GOOGLE_SEARCH_API_KEY || env.GOOGLE_API_KEY;
  const cx = env.GOOGLE_SEARCH_CX || env.GOOGLE_SEARCH_ENGINE_ID || env.GOOGLE_CSE_ID;

  if (!key || !cx) {
    throw new Error(
      "для поиска Google нужны GOOGLE_SEARCH_API_KEY (можно GOOGLE_API_KEY) и GOOGLE_SEARCH_CX"
    );
  }

  // Берём не только первую страницу, иначе при одном запросе быстро начнутся повторы.
  const starts = [1, 11, 21, 31, 41, 51, 61, 71, 81].sort(() => Math.random() - 0.5).slice(0, 3);
  const all = [];

  for (const start of starts) {
    const cacheKey = `imgsearch:google:${hash(query)}:${start}`;
    if (!force) {
      const cached = await env.BOT_KV.get(cacheKey, "json").catch(() => null);
      if (cached?.length) {
        all.push(...cached);
        continue;
      }
    }

    const url =
      "https://www.googleapis.com/customsearch/v1" +
      `?key=${encodeURIComponent(key)}` +
      `&cx=${encodeURIComponent(cx)}` +
      "&searchType=image&safe=active&filter=1&num=10&imgType=photo&imgSize=large" +
      `&start=${start}` +
      `&q=${encodeURIComponent(query)}`;

    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Google Image Search HTTP ${response.status}: ${body.slice(0, 180)}`);
    }

    const data = await response.json();
    const items = (data.items || []).map((item) => ({
      link: item.link,
      title: item.title || "",
      contextLink: item.image?.contextLink || "",
      mime: item.mime || "",
      width: item.image?.width || null,
      height: item.image?.height || null,
    })).filter(imageLike);

    await env.BOT_KV.put(cacheKey, JSON.stringify(items), { expirationTtl: CACHE_TTL });
    all.push(...items);
  }

  return unique(all);
}

function htmlDecode(text) {
  return String(text || "")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function unescapeJsonString(value) {
  try {
    return JSON.parse('"' + String(value).replace(/"/g, '\\"') + '"');
  } catch {
    return String(value).replace(/\\\//g, "/");
  }
}

async function pixabaySearch(query, env, force = false) {
  if (!env.PIXABAY_API_KEY) throw new Error("для Pixabay нужен PIXABAY_API_KEY");

  const page = Math.max(1, Math.floor(Math.random() * 8) + 1);
  const cacheKey = `imgsearch:pixabay:${hash(query)}:${page}`;
  if (!force) {
    const cached = await env.BOT_KV.get(cacheKey, "json").catch(() => null);
    if (cached?.length) return cached;
  }

  const url =
    "https://pixabay.com/api/" +
    `?key=${encodeURIComponent(env.PIXABAY_API_KEY)}` +
    `&q=${encodeURIComponent(query)}` +
    "&image_type=photo&safesearch=true&per_page=50&orientation=all" +
    `&page=${page}`;

  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Pixabay HTTP ${response.status}: ${body.slice(0, 180)}`);
  }

  const data = await response.json();
  const items = (data.hits || []).map((item) => ({
    link: item.largeImageURL || item.webformatURL,
    title: item.tags || query,
    contextLink: item.pageURL || "pixabay.com",
    mime: "image/jpeg",
    width: item.imageWidth || null,
    height: item.imageHeight || null,
  })).filter(imageLike);

  await env.BOT_KV.put(cacheKey, JSON.stringify(items), { expirationTtl: CACHE_TTL });
  return unique(items);
}

async function pexelsSearch(query, env, force = false) {
  if (!env.PEXELS_API_KEY) throw new Error("для Pexels нужен PEXELS_API_KEY");

  const page = Math.max(1, Math.floor(Math.random() * 8) + 1);
  const cacheKey = `imgsearch:pexels:${hash(query)}:${page}`;
  if (!force) {
    const cached = await env.BOT_KV.get(cacheKey, "json").catch(() => null);
    if (cached?.length) return cached;
  }

  const url =
    "https://api.pexels.com/v1/search" +
    `?query=${encodeURIComponent(query)}` +
    "&per_page=40&orientation=square" +
    `&page=${page}`;

  const response = await fetch(url, {
    headers: { Authorization: env.PEXELS_API_KEY, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Pexels HTTP ${response.status}: ${body.slice(0, 180)}`);
  }

  const data = await response.json();
  const items = (data.photos || []).map((item) => ({
    link: item.src?.large2x || item.src?.large || item.src?.original,
    title: item.alt || query,
    contextLink: item.photographer_url || item.url || "pexels.com",
    mime: "image/jpeg",
    width: item.width || null,
    height: item.height || null,
  })).filter(imageLike);

  await env.BOT_KV.put(cacheKey, JSON.stringify(items), { expirationTtl: CACHE_TTL });
  return unique(items);
}

async function serperSearch(query, env, force = false) {
  if (!env.SERPER_API_KEY) throw new Error("для Serper нужен SERPER_API_KEY");

  const cacheKey = `imgsearch:serper:${hash(query)}`;
  if (!force) {
    const cached = await env.BOT_KV.get(cacheKey, "json").catch(() => null);
    if (cached?.length) return cached;
  }

  const response = await fetch("https://google.serper.dev/images", {
    method: "POST",
    headers: {
      "X-API-KEY": env.SERPER_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ q: query, gl: "ru", hl: "ru", safe: "active", num: 30 }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Serper Images HTTP ${response.status}: ${body.slice(0, 180)}`);
  }

  const data = await response.json();
  const items = (data.images || []).map((item) => ({
    link: item.imageUrl || item.thumbnailUrl,
    title: item.title || "",
    contextLink: item.link || item.source || item.domain || "",
    mime: "",
    width: item.imageWidth || null,
    height: item.imageHeight || null,
  })).filter(imageLike);

  await env.BOT_KV.put(cacheKey, JSON.stringify(items), { expirationTtl: CACHE_TTL });
  return unique(items);
}

async function braveSearch(query, env, force = false) {
  if (!env.BRAVE_SEARCH_API_KEY) throw new Error("для Brave Search нужен BRAVE_SEARCH_API_KEY");

  const cacheKey = `imgsearch:brave:${hash(query)}`;
  if (!force) {
    const cached = await env.BOT_KV.get(cacheKey, "json").catch(() => null);
    if (cached?.length) return cached;
  }

  const url =
    "https://api.search.brave.com/res/v1/images/search" +
    `?q=${encodeURIComponent(query)}` +
    "&country=ALL&search_lang=ru&count=50&safesearch=strict";

  const response = await fetch(url, {
    headers: {
      "X-Subscription-Token": env.BRAVE_SEARCH_API_KEY,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Brave Images HTTP ${response.status}: ${body.slice(0, 180)}`);
  }

  const data = await response.json();
  const items = (data.results || []).map((item) => ({
    link: item.properties?.url || item.thumbnail?.src,
    title: item.title || "",
    contextLink: item.url || item.source || "",
    mime: item.properties?.format ? `image/${String(item.properties.format).toLowerCase()}` : "",
    width: item.properties?.width || null,
    height: item.properties?.height || null,
  })).filter(imageLike);

  await env.BOT_KV.put(cacheKey, JSON.stringify(items), { expirationTtl: CACHE_TTL });
  return unique(items);
}


async function duckDuckGoSearch(query, env, force = false) {
  const page = Math.max(0, Math.floor(Math.random() * 5));
  const cacheKey = `imgsearch:duckduckgo:${hash(query)}:${page}`;
  if (!force) {
    const cached = await env.BOT_KV.get(cacheKey, "json").catch(() => null);
    if (cached?.length) return cached;
  }

  const homeUrl = "https://duckduckgo.com/?iax=images&ia=images&q=" + encodeURIComponent(query);
  const home = await fetch(homeUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 GoodMorningBot/2.0",
      "Accept-Language": "ru,en;q=0.8",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!home.ok) throw new Error(`DuckDuckGo HTTP ${home.status}`);

  const html = await home.text();
  const vqd =
    html.match(/vqd=['"]([^'"]+)['"]/)?.[1] ||
    html.match(/vqd=([^&"']+)/)?.[1];
  if (!vqd) throw new Error("DuckDuckGo не вернул search token");

  const url =
    "https://duckduckgo.com/i.js" +
    `?l=ru-ru&o=json&q=${encodeURIComponent(query)}` +
    `&vqd=${encodeURIComponent(vqd)}` +
    "&f=,,,,,&p=1" +
    (page ? `&s=${page * 50}` : "");

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 GoodMorningBot/2.0",
      "Accept": "application/json",
      "Referer": homeUrl,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`DuckDuckGo Images HTTP ${response.status}: ${body.slice(0, 180)}`);
  }

  const data = await response.json();
  const items = (data.results || []).map((item) => ({
    link: item.image || item.thumbnail,
    title: item.title || query,
    contextLink: item.url || "duckduckgo.com",
    mime: "",
    width: item.width || null,
    height: item.height || null,
  })).filter(imageLike);

  await env.BOT_KV.put(cacheKey, JSON.stringify(items), { expirationTtl: CACHE_TTL });
  return unique(items);
}

async function yandexSearch(query, env, force = false) {
  const p = Math.floor(Math.random() * 8);
  const cacheKey = `imgsearch:yandex:${hash(query)}:${p}`;

  if (!force) {
    const cached = await env.BOT_KV.get(cacheKey, "json").catch(() => null);
    if (cached?.length) return cached;
  }

  const url =
    "https://yandex.com/images/search" +
    `?text=${encodeURIComponent(query)}` +
    "&isize=large&iorient=square&family=yes" +
    `&p=${p}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 GoodMorningBot/2.0 (+https://telegram.org)",
      "Accept-Language": "ru,en;q=0.8",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Yandex Images HTTP ${response.status}`);
  }

  const html = htmlDecode(await response.text());
  const results = [];
  const re = /"img_href"\s*:\s*"(https?:\\?\/\\?\/[^"\\]*(?:\\.[^"\\]*)*)"/g;
  let m;
  while ((m = re.exec(html)) && results.length < 40) {
    const link = unescapeJsonString(m[1]);
    results.push({ link, title: query, contextLink: "yandex.com/images", mime: "" });
  }

  const filtered = unique(results).filter(imageLike);
  await env.BOT_KV.put(cacheKey, JSON.stringify(filtered), { expirationTtl: CACHE_TTL });
  return filtered;
}

async function searchImages(query, env, force = false) {
  const provider = String(env.IMAGE_SEARCH_PROVIDER || "auto").toLowerCase();

  if (provider === "yandex") return { provider, results: await yandexSearch(query, env, force) };
  if (provider === "duckduckgo" || provider === "ddg") return { provider: "duckduckgo", results: await duckDuckGoSearch(query, env, force) };
  if (provider === "pixabay") return { provider, results: await pixabaySearch(query, env, force) };
  if (provider === "pexels") return { provider, results: await pexelsSearch(query, env, force) };
  if (provider === "serper") return { provider, results: await serperSearch(query, env, force) };
  if (provider === "brave") return { provider, results: await braveSearch(query, env, force) };
  if (provider === "google") return { provider, results: await googleSearch(query, env, force) };

  // auto для релевантности: сначала бесплатные поисковые выдачи, близкие
  // к обычному поиску, затем стоковые API, затем trial/credit API.
  const order = [
    ["yandex", yandexSearch],
    ["duckduckgo", duckDuckGoSearch],
    ["pixabay", pixabaySearch],
    ["pexels", pexelsSearch],
    ["serper", serperSearch],
    ["brave", braveSearch],
    ["google", googleSearch],
  ];

  let lastError = null;
  for (const [name, fn] of order) {
    try {
      const results = await fn(query, env, force);
      if (results.length) return { provider: name, results };
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error("нет доступных поисковых провайдеров");
}

async function downloadCandidate(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 GoodMorningBot/2.0" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`download HTTP ${response.status}`);

  const type = response.headers.get("content-type") || "";
  if (type && !type.toLowerCase().startsWith("image/")) {
    throw new Error(`не картинка: ${type}`);
  }

  const len = Number(response.headers.get("content-length") || 0);
  if (len > MAX_IMAGE_BYTES) throw new Error("картинка слишком большая для Telegram");

  const buf = await response.arrayBuffer();
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error("картинка слишком большая для Telegram");

  return { bytes: new Uint8Array(buf), mimeType: type || "image/jpeg" };
}

export async function getSearchImage(chatId, queryValue, env, avoidLast = 30) {
  const query = normalizeQuery(queryValue);
  if (query.length < 2) throw new Error("поисковый запрос пустой. Задайте /set_search кот работяга");

  const started = Date.now();
  const recentKey = `imgsearch:recent:${chatId}:${hash(query)}`;
  const recent = (await env.BOT_KV.get(recentKey, "json").catch(() => null)) || [];

  let found = await searchImages(query, env, false);
  if (!found.results.length) found = await searchImages(query, env, true);
  if (!found.results.length) throw new Error("поиск не нашёл подходящих картинок");

  let pool = found.results.filter((r) => !recent.includes(r.link));
  if (!pool.length) {
    // Пробуем свежую страницу, но если вариантов всё равно нет — разрешаем старые,
    // иначе бот перестанет слать картинки на узком запросе.
    const fresh = await searchImages(query, env, true).catch(() => ({ provider: found.provider, results: [] }));
    const merged = unique([...fresh.results, ...found.results]);
    pool = merged.filter((r) => !recent.includes(r.link));
    if (!pool.length) pool = merged;
  }

  const shuffled = pool.sort(() => Math.random() - 0.5).slice(0, 8);
  let lastError = null;

  for (const item of shuffled) {
    try {
      const downloaded = await downloadCandidate(item.link);
      const nextRecent = [item.link, ...recent.filter((x) => x !== item.link)].slice(0, avoidLast);
      await env.BOT_KV.put(recentKey, JSON.stringify(nextRecent), { expirationTtl: RECENT_TTL });

      return {
        ok: true,
        bytes: downloaded.bytes,
        provider: `search:${found.provider}`,
        model: "image-search",
        assetRef: item.link,
        assetName: item.title || query,
        mimeType: downloaded.mimeType,
        kind: "photo",
        query,
        latency: Date.now() - started,
      };
    } catch (e) {
      lastError = e;
    }
  }

  throw new Error("не удалось скачать найденные картинки: " + String(lastError?.message || lastError || ""));
}
