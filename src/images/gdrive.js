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


// Google на разные проблемы отвечает одинаково невнятно.
// Переводим ответ в конкретную причину и подсказку.
function explainDriveError(status, body) {
  const text = String(body);

  if (/API key not valid/i.test(text)) {
    return (
      "ключ Google недействителен.\n\n" +
      "Проверьте: ключ скопирован полностью (начинается с AIza, без пробелов) " +
      "и добавлен в секрет GOOGLE_API_KEY воркера."
    );
  }
  if (/has not been used in project|SERVICE_DISABLED|accessNotConfigured/i.test(text)) {
    return (
      "в проекте Google Cloud не включён Drive API.\n\n" +
      "Откройте console.cloud.google.com → APIs & Services → Library → " +
      "Google Drive API → Enable. После включения подождите пару минут."
    );
  }
  if (/API_KEY_HTTP_REFERRER|API_KEY_ANDROID|API_KEY_IOS|requests from referer/i.test(text)) {
    return (
      "у ключа стоят ограничения по источнику (HTTP referrer / приложение).\n\n" +
      "Cloudflare Worker обращается с сервера. В настройках ключа выберите " +
      "Application restrictions → None."
    );
  }
  if (status === 403 && /rateLimitExceeded|quotaExceeded/i.test(text)) {
    return "превышена квота Google Drive API. Подождите и попробуйте снова.";
  }
  if (status === 404) {
    return "папка не найдена. Проверьте ссылку.";
  }
  if (status === 403) {
    return (
      "нет доступа к папке.\n\n" +
      "Откройте папку → Поделиться → Все, у кого есть ссылка → Читатель."
    );
  }
  return text.slice(0, 200);
}



export async function listImages(folderId, env, force = false) {
  if (!env.GOOGLE_API_KEY) {
    throw new Error(
      "не задан секрет GOOGLE_API_KEY.\n\n" +
      "Workers & Pages → gm → Settings → Variables and Secrets → Add (тип Secret)."
    );
  }

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
    throw new Error(explainDriveError(response.status, body));
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
    throw new Error("скачивание файла: " + explainDriveError(response.status, body));
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
