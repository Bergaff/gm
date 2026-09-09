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
  const provider = String(env.IMAGE_SEARCH_PROVIDER || "google").toLowerCase();

  if (provider === "yandex") return yandexSearch(query, env, force);
  if (provider === "google") return googleSearch(query, env, force);

  // auto: сначала Google с safe=active, потом Yandex family=yes.
  try {
    return await googleSearch(query, env, force);
  } catch (e) {
    const y = await yandexSearch(query, env, force);
    if (y.length) return y;
    throw e;
  }
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

  let results = await searchImages(query, env, false);
  if (!results.length) results = await searchImages(query, env, true);
  if (!results.length) throw new Error("поиск не нашёл подходящих картинок");

  let pool = results.filter((r) => !recent.includes(r.link));
  if (!pool.length) {
    // Пробуем свежую страницу, но если вариантов всё равно нет — разрешаем старые,
    // иначе бот перестанет слать картинки на узком запросе.
    const fresh = await searchImages(query, env, true).catch(() => []);
    const merged = unique([...fresh, ...results]);
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
        provider: `search:${String(env.IMAGE_SEARCH_PROVIDER || "google").toLowerCase()}`,
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
