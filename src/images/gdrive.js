const LIST_CACHE_TTL = 6 * 60 * 60;
const MAX_TELEGRAM_PHOTO = 9.5 * 1024 * 1024;

export function parseFolderId(input) {
  if (!input) return null;

  const patterns = [
    /\/folders\/([a-zA-Z0-9_-]{10,})/,
    /[?&]id=([a-zA-Z0-9_-]{10,})/,
    /^([a-zA-Z0-9_-]{20,})$/,
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) return match[1];
  }

  return null;
}

export async function listImages(folderId, env, force = false) {
  const cacheKey = `gdrive:${folderId}`;

  if (!force) {
    const cached = await env.BOT_KV.get(cacheKey, "json");
    if (cached?.files?.length) return cached.files;
  }

  const query = [
    `'${folderId}' in parents`,
    "mimeType contains 'image/'",
    "trashed = false",
  ].join(" and ");

  const url =
    "https://www.googleapis.com/drive/v3/files" +
    `?q=${encodeURIComponent(query)}` +
    "&fields=files(id,name,mimeType,size)" +
    "&pageSize=1000" +
    "&supportsAllDrives=true" +
    "&includeItemsFromAllDrives=true" +
    `&key=${env.GOOGLE_API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Drive API ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();

  const files = (data.files || []).filter((file) => {
    const size = Number(file.size || 0);
    return size === 0 || size <= MAX_TELEGRAM_PHOTO;
  });

  await env.BOT_KV.put(
    cacheKey,
    JSON.stringify({ files, updatedAt: Date.now() }),
    { expirationTtl: LIST_CACHE_TTL }
  );

  return files;
}

export async function pickImage(chatId, folderId, env, avoidLast = 15) {
  const files = await listImages(folderId, env);

  if (!files.length) {
    throw new Error("В папке Google Drive нет изображений");
  }

  const recentKey = `recent:${chatId}`;
  const recent = (await env.BOT_KV.get(recentKey, "json")) || [];

  let pool = files.filter((file) => !recent.includes(file.id));
  if (!pool.length) pool = files;

  const chosen = pool[Math.floor(Math.random() * pool.length)];

  const nextRecent = [chosen.id, ...recent].slice(0, avoidLast);
  await env.BOT_KV.put(recentKey, JSON.stringify(nextRecent), {
    expirationTtl: 60 * 60 * 24 * 60,
  });

  return chosen;
}

export async function downloadImage(fileId, env) {
  const url =
    `https://www.googleapis.com/drive/v3/files/${fileId}` +
    `?alt=media&supportsAllDrives=true&key=${env.GOOGLE_API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Drive download ${response.status}: ${body.slice(0, 200)}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

export async function getGdriveImage(chatId, folderId, env, avoidLast) {
  const started = Date.now();
  const file = await pickImage(chatId, folderId, env, avoidLast);
  const bytes = await downloadImage(file.id, env);

  return {
    ok: true,
    bytes,
    provider: "gdrive",
    model: "google-drive",
    assetRef: file.id,
    assetName: file.name,
    latency: Date.now() - started,
  };
}
