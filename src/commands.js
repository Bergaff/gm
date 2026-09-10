import {
  DEFAULT_SETTINGS,
  WEEKDAY_MESSAGES,
  WEEKEND_MESSAGES,
  DAY_MESSAGES,
  HOLIDAY_MESSAGES,
} from "./config.js";
import { sendMessage, sendPhotoBytes, sendMediaBytes, escapeHtml, tg, editMessage } from "./telegram.js";
import { getSettings, patchSettings, registerChat, listChats } from "./storage.js";
import { setPending, getPending, clearPending } from "./pending.js";
import { getRole, canEdit, canGrant, grantUser, revokeUser, listGranted } from "./access.js";
import { parseFolderId, getGdriveImage, listImages } from "./images/gdrive.js";
import { getSearchImage } from "./images/search.js";
import {
  generateImage,
  NIM_PROVIDERS,
  getProvider,
  getApiKeys,
  getAllProviders,
  getCustomProviders,
} from "./images/nim.js";
import { newPostId, savePost, logAttempts, votesByProvider } from "./db.js";
import { localParts, parseTimeSpec, withChatHoliday } from "./scheduler.js";
import { handleStatsCommand } from "./stats.js";
import { usageText, getUsage, FREE_NEURONS_PER_DAY } from "./usage.js";
import {
  parseExamples,
  getExamples,
  saveExamples,
  clearExamples,
  pickExamples,
  examplesText,
} from "./examples.js";
import {
  applyStyle,
  stylesKeyboard,
  stylesText,
  getStyle,
  STYLES,
  negativeFor,
  resolveStyle,
} from "./styles.js";
import {
  generateCaption,
  getTextApiKeys,
  hasDedicatedTextKey,
  getTextModel,
  getGeminiTextModel,
  translatePrompt,
  needsTranslation,
} from "./caption.js";

// Лимит описания характера чата.
// Было 2000 — развёрнутая характеристика на 2300 символов обрезалась
// прямо посреди предложения, и модель теряла последний абзац.
// 4000 спокойно вмещает подробное описание и не раздувает промпт.
const CHARACTER_LIMIT = 4000;

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function mmdd(localDate) {
  return String(localDate || "").slice(5, 10);
}

function birthdayPeople(settings, localDate) {
  const today = mmdd(localDate);
  const birthdays = settings.birthdays || {};
  return Object.entries(birthdays)
    .filter(([, b]) => b?.date === today)
    .map(([id, b]) => ({
      id,
      name: b.name || b.username || id,
      username: b.username || "",
      at: b.username ? "@" + b.username : b.name || id,
    }));
}

function birthdayLine(people) {
  if (!people.length) return "";
  const names = people.map((p) => p.at).join(", ");
  return people.length === 1
    ? `🎂 Сегодня день рождения у ${names}! Поздравляем!`
    : `🎂 Сегодня дни рождения у ${names}! Поздравляем!`;
}

function parseBirthdayDate(value) {
  const raw = String(value || "").trim();
  const iso = raw.match(/^\d{4}-(\d{1,2})-(\d{1,2})$/);
  const m = iso || raw.match(/^(\d{1,2})[.\/\-](\d{1,2})(?:[.\/\-]\d{2,4})?$/);
  if (!m) return null;

  // Основной формат для чата — русский DD.MM. Полный ISO YYYY-MM-DD тоже
  // принимаем. Двухчастное "03-08" трактуется как 3 августа, а не MM-DD.
  const day = Number(iso ? m[2] : m[1]);
  const month = Number(iso ? m[1] : m[2]);

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dim = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day > dim) return null;
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function formatBirthdayDate(mmddValue) {
  const [m, d] = String(mmddValue || "").split("-");
  return d && m ? `${d}.${m}` : String(mmddValue || "");
}

function promptListsText(settings) {
  const section = (title, list) => {
    const items = Array.isArray(list) && list.length
      ? list.map((p, i) => `${i + 1}. ${p}`).join("\n")
      : "— пусто, используется общий промпт";
    return `${title}\n${items}`;
  };

  return [
    section("Будни:", settings.weekdayPrompts || []),
    "",
    section("Выходные:", settings.weekendPrompts || []),
    "",
    `Общий запасной:\n${settings.nimPrompt}`,
  ].join("\n");
}

async function getRecentCaptions(chatId, env, limit = 8) {
  const list = await env.BOT_KV.get(`captions:${chatId}`, "json").catch(() => null);
  return Array.isArray(list) ? list.slice(0, limit) : [];
}

async function rememberCaption(chatId, caption, env) {
  const text = String(caption || "").trim();
  if (!text) return;
  const list = await getRecentCaptions(chatId, env, 20);
  const normalized = (x) => String(x).toLowerCase().replace(/\s+/g, " ").trim();
  const next = [text, ...list.filter((x) => normalized(x) !== normalized(text))].slice(0, 20);
  await env.BOT_KV.put(`captions:${chatId}`, JSON.stringify(next), { expirationTtl: 90 * 24 * 60 * 60 });
}

function parseCaptionTraits(text) {
  return String(text || "")
    .split(/\n|,|;/)
    .map((x) => x.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((x) => x.slice(0, 80));
}

function textProviderLabel(value) {
  return {
    gemini: "Gemini 2.5 Flash",
    auto: "авто (Gemini → внешний API → Cloudflare)",
    external: "внешний OpenAI-compatible API",
    cf: "Cloudflare Workers AI",
  }[value] || value || "gemini";
}

function captionTraitsLabel(traits) {
  const list = Array.isArray(traits) ? traits.filter(Boolean) : [];
  return list.length ? list.join(", ") : "не заданы";
}

export function captionStylesKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "✍️ Задать характеристики", callback_data: "s|caption_traits|edit" }],
      [{ text: "🗑 Очистить", callback_data: "s|caption_traits|clear" }],
      [{ text: "◀️ Назад в меню", callback_data: "nav|menu" }],
    ],
  };
}

export function captionStylesText(settingsOrTraits = []) {
  const traits = Array.isArray(settingsOrTraits)
    ? settingsOrTraits
    : settingsOrTraits?.captionTraits || [];
  return [
    "✍️ <b>Характеристики для AI-подписей</b>",
    "",
    "Это не готовый общий текст, а короткие признаки чата. Пишите каждую с новой строки:",
    "",
    "<code>ироничные\nинженеры\nдобрые\nлюбят мемы\nбез официоза</code>",
    "",
    "<b>Сейчас:</b>",
    traits.length ? traits.map((t) => `• ${escapeHtml(t)}`).join("\n") : "<i>не заданы</i>",
    "",
    "Отправить список: <code>/caption_style</code>",
    "Очистить: <code>/caption_style clear</code>",
    "",
    "<i>Если развёрнутый характер не задан, бот будет брать манеру из общих примеров и перефразировать их.</i>",
  ].join("\n");
}

// Промпт берётся из библиотеки для нужного типа дня.
// Если список пуст — используется одиночный nimPrompt (обратная совместимость).
export function pickPrompt(settings, isWeekend) {
  const list = isWeekend ? settings.weekendPrompts : settings.weekdayPrompts;
  if (Array.isArray(list) && list.length) return pick(list);
  return settings.nimPrompt;
}

export function pickSearchQuery(settings, isWeekend) {
  const list = isWeekend ? settings.weekendSearchQueries : settings.weekdaySearchQueries;
  if (Array.isArray(list) && list.length) return pick(list);
  return settings.searchQuery || settings.nimPrompt;
}

function searchListsText(settings) {
  const section = (title, list) => {
    const items = Array.isArray(list) && list.length
      ? list.map((q, i) => `${i + 1}. ${q}`).join("\n")
      : "— пусто, используется общий поисковый запрос";
    return `${title}\n${items}`;
  };

  return [
    section("Поиск — будни:", settings.weekdaySearchQueries || []),
    "",
    section("Поиск — выходные:", settings.weekendSearchQueries || []),
    "",
    `Общий поисковый запрос:\n${settings.searchQuery || "не задан"}`,
  ].join("\n");
}

export function testPromptsText(settings) {
  return [
    "🧪 <b>Тест промпта</b>",
    "",
    "Выберите промпт кнопкой ниже — бот сразу сделает тестовую отправку именно с ним.",
    "",
    `<pre>${escapeHtml(promptListsText(settings))}</pre>`,
  ].join("\n");
}

export function testPromptsKeyboard(settings) {
  const rows = [];
  const addRows = (kind, title, list) => {
    if (!Array.isArray(list) || !list.length) return;
    for (let i = 0; i < list.length; i += 2) {
      rows.push(list.slice(i, i + 2).map((_, j) => ({
        text: `🧪 ${title} ${i + j + 1}`,
        callback_data: `t|prompt|${kind}|${i + j}`,
      })));
    }
  };
  addRows("weekday", "будни", settings.weekdayPrompts || []);
  addRows("weekend", "выходные", settings.weekendPrompts || []);
  rows.push([{ text: "🎲 Случайный промпт", callback_data: "t|prompt|auto|0" }]);
  rows.push([{ text: "◀️ Назад в меню", callback_data: "nav|menu" }]);
  return { inline_keyboard: rows };
}

export function searchFallbackKeyboard(current = "nim") {
  const mark = (v) => v === current ? "✅ " : "";
  return {
    inline_keyboard: [
      [
        { text: `${mark("nim")}🤖 Генерация ИИ`, callback_data: "s|search_fallback|nim" },
        { text: `${mark("gdrive")}📁 Google Drive`, callback_data: "s|search_fallback|gdrive" },
      ],
      [{ text: "◀️ Назад в меню", callback_data: "nav|menu" }],
    ],
  };
}

export function holidayModeKeyboard(date, current = null) {
  const mark = (v) => v === current ? "✅ " : "";
  return {
    inline_keyboard: [[
      { text: `${mark(false)}📅 Оставить будним`, callback_data: `h|mode|${date}|workday` },
      { text: `${mark(true)}🏖 Сделать выходным`, callback_data: `h|mode|${date}|weekend` },
    ]],
  };
}

export function searchFallbackText(settings) {
  return [
    "🔎 <b>Поисковый запрос подключён</b>",
    "",
    `Запасной источник сейчас: <b>${settings.searchFallback === "gdrive" ? "Google Drive" : "Генерация ИИ"}</b>`,
    "",
    "⚠️ Yandex/DuckDuckGo используются неофициально и иногда могут не отдать картинку.",
    "Выберите второй способ, который бот попробует, если поиск сломается:",
  ].join("\n");
}

export function morningTestReport(result) {
  const report = [
    `Статус: <code>${result.status}</code>`,
    result.provider ? `Источник картинки: <b>${result.provider}</b>` : null,
    result.assetName ? `Файл: <code>${escapeHtml(result.assetName)}</code>` : null,
    result.promptOriginal
      ? `Промпт (RU): <i>${escapeHtml(String(result.promptOriginal))}</i>`
      : null,
    result.prompt
      ? `Промпт${result.promptTranslated ? " (EN, переведён)" : ""}: <i>${escapeHtml(String(result.prompt))}</i>`
      : null,
    result.styleId
      ? `Стиль: <b>${escapeHtml(STYLES[result.styleId]?.title || result.styleId)}</b>` +
        (result.styleRequested && result.styleRequested !== result.styleId
          ? ` <i>(вместо «${escapeHtml(STYLES[result.styleRequested]?.title || result.styleRequested)}» — промпт просит рисунок)</i>`
          : "")
      : null,
    `Подпись: ${result.captionSource === "llm" ? "🤖 сгенерирована" : "📄 шаблон"}`,
    result.captionModel ? `Модель текста: <b>${escapeHtml(result.captionModel)}</b>` : null,
    result.captionError
      ? `⚠️ LLM не ответил: <code>${escapeHtml(String(result.captionError).slice(0, 200))}</code>`
      : null,
    result.error ? `\n<code>${escapeHtml(String(result.error).slice(0, 300))}</code>` : null,
  ].filter(Boolean).join("\n");

  return (result.status === "ok" ? "✅ " : "⚠️ ") + report;
}

function enforcePrompt(prompt) {
  const base = String(prompt || "").trim();
  if (!base) return base;

  // Некоторые image-модели на коротких запросах уходят в «рандом».
  // Жёстко фиксируем главный объект/действие, но не меняем смысл запроса.
  return (
    `Create exactly this scene: ${base}. ` +
    "The main subject, action, objects and mood from the user's prompt are mandatory. " +
    "If style words conflict with the scene, the scene wins. " +
    "Do not substitute a generic sunrise, coffee cup, landscape, or unrelated random objects. " +
    "No readable text, no watermark, safe for work."
  );
}

function addSafetyNegative(negative) {
  const extra = "nsfw, nude, naked, erotic, porn, hentai, gore, watermark, logo, text";
  return [negative, extra].filter(Boolean).join(", ");
}

export function voteKeyboard(postId, likes = 0, dislikes = 0) {
  return {
    inline_keyboard: [
      [
        { text: `👍 ${likes}`, callback_data: `v|${postId}|1` },
        { text: `👎 ${dislikes}`, callback_data: `v|${postId}|-1` },
      ],
    ],
  };
}

// Шаблонная фраза с учётом дня недели.
// У понедельника, пятницы и воскресенья своё настроение — раньше
// в любой день шла одна и та же обезличенная фраза.
function pickTemplate(now) {
  const holiday = now.holidayName ? HOLIDAY_MESSAGES[now.holidayName] : null;
  if (holiday && holiday.length) return pick(holiday);

  const special = DAY_MESSAGES[now.weekday];

  // В «особые» дни половину раз берём тематическую фразу
  if (special && special.length && Math.random() < 0.5) {
    return pick(special);
  }

  return pick(now.isWeekend ? WEEKEND_MESSAGES : WEEKDAY_MESSAGES);
}

export async function sendMorning(chatId, settings, env, options = {}) {
  // forcePrompt: /test заранее показывает промпт пользователю и передаёт
  // его сюда. Без этого pickPrompt вызывался дважды и случайно выбирал
  // РАЗНЫЕ промпты — в превью один, в генерации другой.
  const { test = false, forcePrompt = null } = options;

  const now = withChatHoliday(localParts(settings.timezone), settings);
  const birthdaysToday = birthdayPeople(settings, now.date);

  // Подпись: либо генерирует нейросеть под характер чата, либо готовая фраза.
  let text = pickTemplate(now);
  if (birthdaysToday.length && !settings.aiCaptions) {
    text = `${text}\n\n${birthdayLine(birthdaysToday)}`;
  }
  let captionSource = "template";
  let captionModel = null;
  let captionError = null;

  if (settings.aiCaptions) {
    // Примеры общие для всех чатов, берём несколько случайных.
    // Случайных — чтобы модель не воспроизводила одни и те же.
    const allExamples = await getExamples(env);
    const recentCaptions = await getRecentCaptions(chatId, env);

    const generated = await generateCaption(env, {
      character: settings.character || "",
      isWeekend: now.isWeekend,
      chatTitle: settings.title || "",
      examples: pickExamples(allExamples, 4),
      // Точный день недели: без него модель писала «опять понедельник»
      // во вторник и про конец недели в среду.
      weekday: now.weekday,
      holidayName: now.holidayName || "",
      birthdays: birthdaysToday,
      captionTraits: settings.captionTraits || [],
      recentCaptions,
      textProvider: settings.textProvider || "gemini",
    });
    if (generated.ok) {
      text = generated.text;
      captionSource = "llm";
      captionModel = generated.model || null;
    } else {
      // Раньше сбой глотался молча, и было непонятно, почему подписи
      // остаются шаблонными. Теперь причина видна в /test.
      captionError = generated.error || "неизвестная ошибка";
    }
  }

  // ВАЖНО: подпись уходит с parse_mode=HTML. Любой символ «<» из текста
  // нейросети Telegram пытается разобрать как тег и отвечает 400
  // «can't parse entities: Unsupported start tag». Экранируем.
  const safeText = escapeHtml(text);

  const caption = test
    ? `🧪 <i>Тестовая отправка</i>\n\n${safeText}`
    : safeText;

  const postId = newPostId();
  const folderId = parseFolderId(settings.gdriveFolder);
  const useSearch = settings.source === "search";
  const searchQuery = String(pickSearchQuery(settings, now.isWeekend) || "").trim();

  let useNim = settings.source === "nim";
  if (settings.source === "mixed") {
    useNim = Math.random() < (settings.mixedNimChance ?? 0.5);
  }

  let image = null;
  let attempts = [];
  let error = null;

  // --- основной источник ---
  const rawPrompt = forcePrompt || pickPrompt(settings, now.isWeekend);

  // Модели генерации понимают только английский. Русский промпт переводим,
  // результат кэшируется — повторный перевод того же текста не нужен.
  let activePrompt = rawPrompt;
  let promptTranslated = false;

  let promptError = null;

  if (useNim && needsTranslation(rawPrompt)) {
    const tr = await translatePrompt(rawPrompt, env);
    activePrompt = tr.text;
    promptTranslated = tr.translated;

    // Если русский промпт не перевёлся, не отдаём его image-модели как есть:
    // именно так появлялись «случайные картинки», не связанные с запросом.
    if (!tr.translated) {
      promptError = tr.error || "русский промпт не удалось перевести на английский";
    }
  }

  // Дописываем стиль: «кот на полу» -> «cat on the floor, professional
  // photography, 85mm lens, ...». Если промпт уже развёрнутый — не трогаем.
  let styleApplied = false;
  let styleUsed = settings.imageStyle;
  let negative = "";

  if (useNim) {
    // resolveStyle не даст «Фотореализм» поверх промпта «аниме тян»:
    // такой набор приказов модель отрабатывает мылом.
    styleUsed = resolveStyle(activePrompt, settings.imageStyle);
    negative = addSafetyNegative(negativeFor(settings.imageStyle, activePrompt));
    const withStyle = applyStyle(activePrompt, settings.imageStyle);
    styleApplied = withStyle !== activePrompt;
    activePrompt = enforcePrompt(withStyle);
  }

  if (useNim) {
    if (promptError) {
      error = "Промпт не отправлен в генератор: " + promptError;
      attempts = [{ provider: "prompt", ok: false, status: 0, latency: 0, error }];
    } else {
      const result = await generateImage(activePrompt, env, {
        preferred: settings.nimModel,
        chatId,
        negative,
      });
      attempts = result.attempts || [];
      if (result.ok) image = result;
      else error = "Все модели генерации недоступны";
    }
  } else if (useSearch) {
    try {
      image = await getSearchImage(chatId, searchQuery || rawPrompt, env, settings.avoidRepeatLast);
    } catch (e) {
      error = String(e);
    }
  } else if (folderId) {
    try {
      image = await getGdriveImage(chatId, folderId, env, settings.avoidRepeatLast);
    } catch (e) {
      error = String(e);
    }
  } else {
    error = "Источник картинок не настроен";
  }

  async function tryGeneratedFallback() {
    let fallbackPrompt = rawPrompt;
    let fallbackNegative = "";
    let fallbackPromptError = null;

    if (needsTranslation(rawPrompt)) {
      const tr = await translatePrompt(rawPrompt, env);
      fallbackPrompt = tr.text;
      if (!tr.translated) fallbackPromptError = tr.error || "русский промпт не удалось перевести";
    }

    if (fallbackPromptError) {
      attempts.push({ provider: "prompt", ok: false, status: 0, latency: 0, error: fallbackPromptError });
      return null;
    }

    fallbackNegative = addSafetyNegative(negativeFor(settings.imageStyle, fallbackPrompt));
    fallbackPrompt = enforcePrompt(applyStyle(fallbackPrompt, settings.imageStyle));
    const result = await generateImage(fallbackPrompt, env, {
      preferred: settings.nimModel,
      chatId,
      negative: fallbackNegative,
    });
    attempts = attempts.concat(result.attempts || []);
    if (result.ok) {
      activePrompt = fallbackPrompt;
      negative = fallbackNegative;
      return result;
    }
    return null;
  }

  async function tryDriveFallback() {
    if (!folderId) return null;
    try {
      return await getGdriveImage(chatId, folderId, env, settings.avoidRepeatLast);
    } catch (e) {
      error = `${error}; fallback Drive: ${e}`;
      return null;
    }
  }

  // --- запасной источник ---
  if (!image) {
    if (useNim && folderId) {
      try {
        image = await getGdriveImage(chatId, folderId, env, settings.avoidRepeatLast);
      } catch (e) {
        error = `${error}; fallback Drive: ${e}`;
      }
    } else if (useNim && searchQuery) {
      try {
        image = await getSearchImage(chatId, searchQuery, env, settings.avoidRepeatLast);
      } catch (e) {
        error = `${error}; fallback Search: ${e}`;
      }
    } else if (useSearch) {
      // Поиск — неофициальный источник. Если он не отдал картинку,
      // пробуем запасной источник, который выбрали в настройках поиска.
      const fallback = settings.searchFallback === "gdrive" ? "gdrive" : "nim";
      image = fallback === "gdrive" ? await tryDriveFallback() : await tryGeneratedFallback();
      if (!image) image = fallback === "gdrive" ? await tryGeneratedFallback() : await tryDriveFallback();
    } else if (!useNim && !useSearch) {
      // Fallback из Drive в генерацию: готовим промпт так же строго, как
      // для основного NIM-источника, включая перевод. Не отправляем кириллицу
      // напрямую, чтобы не получать случайные картинки.
      let fallbackPrompt = rawPrompt;
      let fallbackNegative = "";
      let fallbackPromptError = null;

      if (needsTranslation(rawPrompt)) {
        const tr = await translatePrompt(rawPrompt, env);
        fallbackPrompt = tr.text;
        if (!tr.translated) fallbackPromptError = tr.error || "русский промпт не удалось перевести";
      }

      if (!fallbackPromptError) {
        fallbackNegative = addSafetyNegative(negativeFor(settings.imageStyle, fallbackPrompt));
        fallbackPrompt = enforcePrompt(applyStyle(fallbackPrompt, settings.imageStyle));
        const result = await generateImage(fallbackPrompt, env, {
          preferred: settings.nimModel,
          chatId,
          negative: fallbackNegative,
        });
        attempts = attempts.concat(result.attempts || []);
        if (result.ok) {
          image = result;
          activePrompt = fallbackPrompt;
          negative = fallbackNegative;
        }
      } else {
        attempts.push({ provider: "prompt", ok: false, status: 0, latency: 0, error: fallbackPromptError });
      }
    }
  }

  await logAttempts(env, chatId, attempts);

  let messageId = null;
  let tgFileId = null;
  let status = "ok";

  if (image) {
    const markup = settings.votingEnabled ? voteKeyboard(postId) : undefined;

    // Из Google Drive может прийти GIF или видео — им нужны
    // sendAnimation / sendVideo, иначе анимация станет картинкой.
    const sent = await sendMediaBytes(chatId, image.bytes, caption, env, {
      kind: image.kind || "photo",
      mimeType: image.mimeType || "",
      filename: image.assetName || "",
      reply_markup: markup,
    });

    if (sent.ok) {
      messageId = sent.result.message_id;
      // У каждого типа file_id лежит в своём поле
      const photos = sent.result.photo || [];
      tgFileId =
        photos[photos.length - 1]?.file_id ||
        sent.result.animation?.file_id ||
        sent.result.video?.file_id ||
        sent.result.document?.file_id ||
        null;
    } else {
      status = "tg_error";
      error = JSON.stringify(sent).slice(0, 300);
    }
  } else {
    status = "no_image";

    // Раньше причина была видна только в /test. В обычной рассылке
    // приходило глухое «не удалось», и было непонятно, что чинить.
    let hint = "";
    if (settings.source === "search" && !settings.searchQuery) {
      hint = "\n<i>Поисковый запрос не задан: /set_search кот работяга</i>";
    } else if (settings.source === "search") {
      hint = "\n<i>Поиск не сработал. Так как он неофициальный, настройте запасной источник: /set_gdrive или /set_source nim</i>";
    } else if (!settings.gdriveFolder && settings.source === "gdrive") {
      hint = "\n<i>Источник не настроен: /set_source nim или /set_gdrive</i>";
    } else if (attempts.some((a) => a.status === 429 ||
               /limit|quota|exceed/i.test(String(a.error || "")))) {
      hint = "\n<i>Похоже, кончился дневной лимит Workers AI — /usage</i>";
    } else if (attempts.length) {
      const first = attempts.find((a) => !a.ok);
      if (first) {
        hint = `\n<i>${escapeHtml(String(first.error || "").slice(0, 120))}</i>`;
      }
    }

    const sent = await sendMessage(
      chatId,
      `${caption}\n\n<i>⚠️ Картинку получить не удалось</i>${hint}`,
      env
    );
    if (sent.ok) messageId = sent.result.message_id;
  }

  if (status === "ok") {
    await rememberCaption(chatId, text, env).catch(() => null);
  }

  await savePost(env, {
    id: postId,
    chatId,
    chatTitle: settings.title,
    messageId,
    localDate: now.date,
    isWeekend: now.isWeekend,
    source: image?.provider === "gdrive"
      ? "gdrive"
      : String(image?.provider || "").startsWith("search:")
        ? "search"
        : useNim ? "nim" : useSearch ? "search" : "gdrive",
    provider: image?.provider || null,
    model: image?.model || null,
    prompt: useNim ? activePrompt : useSearch ? (image?.query || searchQuery || rawPrompt) : null,
    assetRef: image?.assetRef || null,
    assetName: image?.assetName || null,
    tgFileId,
    latency: image?.latency || null,
    status,
    error,
  });

  return {
    postId,
    status,
    provider: image?.provider,
    error,
    prompt: useNim ? activePrompt : useSearch ? (image?.query || searchQuery || rawPrompt) : null,
    promptOriginal: useNim && promptTranslated ? rawPrompt : null,
    promptTranslated,
    captionSource,
    captionModel,
    captionError,
    styleApplied,
    styleId: styleUsed,
    styleRequested: settings.imageStyle,
    negative,
    attempts,
    caption: text,
    assetName: image?.assetName || null,
  };
}


// ── /change — владелец видит модели во ВСЕХ чатах и меняет их ─────────
// Обычные команды правят только тот чат, где отправлены. Здесь владелец
// работает с любым чатом, не заходя в него.
// Telegram режет сообщение на 4096 символах и кнопки на ~100 штуках.
// При большом числе чатов ответ не влезал, приходил HTTP 400,
// и бот молчал. Показываем страницами.
const CHATS_PER_PAGE = 20;

export async function changeText(env, listChats, getSettings, page = 0) {
  const all = await listChats(env);
  const pages = Math.max(1, Math.ceil(all.length / CHATS_PER_PAGE));
  const cur = Math.min(Math.max(0, page), pages - 1);
  const ids = all.slice(cur * CHATS_PER_PAGE, (cur + 1) * CHATS_PER_PAGE);

  const providers = getAllProviders(env);
  const lines = ["🔧 <b>Модели по чатам</b>", ""];

  if (pages > 1) {
    lines.push(`Страница <b>${cur + 1}</b> из <b>${pages}</b> · всего чатов: ${all.length}`);
    lines.push("");
  }

  for (const id of ids) {
    const s = await getSettings(id, env);
    const idx = providers.findIndex((p) => p.id === s.nimModel);
    const model = s.nimModel === "auto"
      ? "🎲 Авто"
      : idx >= 0
        ? `Модель ${idx + 1} — ${providers[idx].title}`
        : s.nimModel;

    lines.push(`• <b>${escapeHtml(s.title || id)}</b>`);
    lines.push(`   ${s.enabled ? "🟢" : "🔴"} ${escapeHtml(model)}`);
    lines.push(`   стиль: ${getStyle(s.imageStyle).title} · ${s.source}`);
  }

  if (!all.length) lines.push("<i>Бот пока никуда не добавлен.</i>");
  else {
    lines.push("");
    lines.push("<i>Нажмите чат, чтобы сменить в нём модель.</i>");
    lines.push("<i>Участники чата этого не увидят.</i>");
  }

  return lines.join("\n");
}

export async function changeKeyboard(env, listChats, getSettings, page = 0) {
  const all = await listChats(env);
  const pages = Math.max(1, Math.ceil(all.length / CHATS_PER_PAGE));
  const cur = Math.min(Math.max(0, page), pages - 1);
  const ids = all.slice(cur * CHATS_PER_PAGE, (cur + 1) * CHATS_PER_PAGE);

  const rows = [];

  for (const id of ids) {
    const s = await getSettings(id, env);
    rows.push([{
      text: `${s.enabled ? "🟢" : "🔴"} ${String(s.title || id).slice(0, 30)}`,
      callback_data: `c|pick|${id}`,
    }]);
  }

  if (pages > 1) {
    const nav = [];
    if (cur > 0) nav.push({ text: "◀️", callback_data: `c|page|${cur - 1}` });
    nav.push({ text: `${cur + 1}/${pages}`, callback_data: "c|noop|-" });
    if (cur < pages - 1) nav.push({ text: "▶️", callback_data: `c|page|${cur + 1}` });
    rows.push(nav);
  }

  return { inline_keyboard: rows };
}

// Экран выбора модели для КОНКРЕТНОГО чата (по его id)
export function changeModelsKeyboard(env, targetId, current) {
  const providers = getAllProviders(env);

  // Номера в два столбца: с 6 моделями экран помещается целиком,
  // не надо листать список из полноразмерных кнопок.
  const rows = [];
  for (let i = 0; i < providers.length; i += 2) {
    rows.push(
      providers.slice(i, i + 2).map((p, j) => ({
        text: `${p.id === current ? "✅ " : ""}${i + j + 1}. ${p.title.slice(0, 22)}`,
        callback_data: `c|set|${targetId}|${p.id}`,
      }))
    );
  }

  rows.unshift([{
    text: `${current === "auto" ? "✅ " : ""}🎲 Случайно (перебор всех)`,
    callback_data: `c|set|${targetId}|auto`,
  }]);

  rows.push([{ text: "◀️ К списку чатов", callback_data: "c|list|-" }]);
  return { inline_keyboard: rows };
}

// Текст экрана выбора модели для конкретного чата: видно, что есть что.
export function changeModelsText(env, title, current) {
  const providers = getAllProviders(env);
  const lines = [`🔧 <b>${title}</b>`, ""];

  lines.push(current === "auto"
    ? "Сейчас: <b>🎲 Случайно</b> — бот перебирает модели сам"
    : "Сейчас: <b>" + (() => {
        const i = providers.findIndex((p) => p.id === current);
        return i >= 0 ? `${i + 1}. ${providers[i].title}` : current;
      })() + "</b>");

  if (current !== "auto") {
    lines.push("<i>Ручной выбор строгий: без тихой подмены на другую модель.</i>");
  }

  lines.push("");
  providers.forEach((p, i) => {
    lines.push(`${p.id === current ? "✅ " : ""}<b>${i + 1}.</b> ${p.title}`);
  });

  lines.push("");
  lines.push("<i>Участники чата этого не увидят.</i>");

  return lines.join("\n");
}

const KNOWN_COMMANDS = new Set([
  "/start", "/help", "/settings", "/id",
  "/set_source", "/set_gdrive", "/refresh_gdrive", "/set_search",
  "/searches", "/add_search", "/del_search",
  "/prompts", "/set_prompt", "/add_prompt", "/del_prompt", "/edit_prompt",
  "/models", "/set_model", "/set_text_provider", "/set_timezone", "/style", "/caption_style",
  "/birthday", "/birthdays", "/birthday_remove",
  "/holiday", "/holidays", "/holiday_remove",
  "/set_weekday_time", "/set_weekend_time",
  "/voting_on", "/voting_off", "/enable", "/disable",
  "/test", "/reset", "/cancel", "/diag", "/menu",
  "/set_character", "/ai_on", "/ai_off",
  "/grant", "/revoke", "/access",
  "/stats", "/stats_models", "/stats_chats", "/stats_recent",
  "/stats_post", "/stats_errors", "/nim_health", "/chats", "/export_csv", "/usage",
  "/change", "/examples", "/examples_clear",
]);

// Команды, которые умеют работать в два шага: сначала вопрос, потом ответ.
const PENDING_PROMPTS = {
  set_gdrive: "Пришлите ссылку на публичную папку Google Drive следующим сообщением.\n\n<i>/cancel — отмена</i>",
  set_search:
    "Пришлите поисковый запрос для картинок.\n\n" +
    "<i>Пример: кот работяга</i>\n\n" +
    "⚠️ Поиск через Yandex/DuckDuckGo неофициальный: он может иногда не отдать картинку. " +
    "Поэтому лучше дополнительно настроить второй способ: Google Drive (/set_gdrive) " +
    "или генерацию ИИ (/set_source nim).\n\n" +
    "<i>/cancel — отмена</i>",
  set_caption_traits: "Пришлите короткие характеристики чата, каждую с новой строки.\n\n<i>Например:</i>\n<code>ироничные\nинженеры\nдобрые\nлюбят мемы</code>\n\n<i>/cancel — отмена</i>",
  add_search_weekday: "Пришлите поисковый запрос для <b>будней</b>.\n\n<i>Пример: кот работяга</i>\n<i>/cancel — отмена</i>",
  add_search_weekend: "Пришлите поисковый запрос для <b>выходных</b>.\n\n<i>Пример: кот отдыхает с кофе</i>\n<i>/cancel — отмена</i>",
  add_prompt_weekday: "Пришлите текст промпта для <b>будней</b> следующим сообщением.\n\n<i>/cancel — отмена</i>",
  add_prompt_weekend: "Пришлите текст промпта для <b>выходных</b> следующим сообщением.\n\n<i>/cancel — отмена</i>",
  set_weekday_time: "Пришлите время для будней: <code>09:00</code> или диапазон <code>09:00-09:40</code>.\n\n<i>/cancel — отмена</i>",
  set_weekend_time: "Пришлите время для выходных: <code>10:30</code> или диапазон <code>10:00-11:00</code>.\n\n<i>/cancel — отмена</i>",
};

export function sourceKeyboard(current) {
  const mark = (v) => (v === current ? "✅ " : "");
  return {
    inline_keyboard: [
      [
        { text: `${mark("gdrive")}Google Drive`, callback_data: "s|source|gdrive" },
        { text: `${mark("nim")}Генерация`, callback_data: "s|source|nim" },
      ],
      [
        { text: `${mark("search")}Поисковый запрос`, callback_data: "s|source|search" },
        { text: `${mark("mixed")}Drive + генерация`, callback_data: "s|source|mixed" },
      ],
      [{ text: "◀️ Назад в меню", callback_data: "nav|menu" }],
    ],
  };
}

// Главное меню — единая точка возврата для всех кнопок «Назад».
export function menuKeyboard(settings = null) {
  const enabled = settings ? settings.enabled !== false : true;
  return {
    inline_keyboard: [
      [
        { text: "🖼 Источник", callback_data: "nav|source" },
        { text: "🎨 Стиль", callback_data: "nav|style" },
        { text: "🤖 Модели", callback_data: "nav|models" },
      ],
      [
        { text: "📝 Промпты будни", callback_data: "p|show|weekday" },
        { text: "📝 Выходные", callback_data: "p|show|weekend" },
      ],
      [
        { text: "✍️ Характеристики", callback_data: "nav|caption_style" },
        { text: "⚙️ Настройки", callback_data: "nav|settings" },
      ],
      [
        { text: enabled ? "⛔ Отключить бота" : "✅ Включить бота", callback_data: "s|enabled|toggle" },
        { text: "🩺 Диагностика", callback_data: "nav|diag" },
      ],
    ],
  };
}

export function modelsKeyboard(providers, current, stats = {}) {
  // Нумеруем «Модель 1..N» — столько, сколько реально доступно по ключу,
  // и показываем лайки/дизлайки каждой прямо на кнопке.
  const rows = providers.map((p, i) => {
    const st = stats[p.id];
    const score = st ? ` 👍${st.likes} 👎${st.dislikes}${st.switchedFails ? ` ⚠${st.switchedFails}` : ""}` : "";
    return [{
      text: `${p.id === current ? "✅ " : ""}Модель ${i + 1}${score}`,
      callback_data: `s|model|${p.id}`,
    }];
  });

  rows.unshift([{
    text: `${current === "auto" ? "✅ " : ""}🎲 Авто (перебор всех)`,
    callback_data: "s|model|auto",
  }]);

  rows.push([{ text: "◀️ Назад в меню", callback_data: "nav|menu" }]);
  return { inline_keyboard: rows };
}

// Текст со списком моделей: номер, название, статистика голосов
export function modelsText(providers, current, stats, keyCount) {
  const lines = [
    "🤖 <b>Модели генерации</b>",
    "",
    `Ключей NVIDIA загружено: <b>${keyCount}</b>`,
    `OpenRouter: <b>${providers.some((p) => p.openrouter) ? "подключён" : "нет ключа"}</b>`,
    `Доступно моделей: <b>${providers.length}</b>`,
    "",
  ];

  providers.forEach((p, i) => {
    const st = stats[p.id];
    const mark = p.id === current ? "✅ " : "";
    lines.push(`${mark}<b>Модель ${i + 1}</b> — ${escapeHtml(p.title)}`);
    if (st) {
      const total = st.likes + st.dislikes;
      const rate = total ? Math.round((st.likes / total) * 100) + "%" : "—";
      const fail = st.apiFails ? ` · сбоев ${st.apiFails}` : "";
      const switched = st.switchedFails ? ` · автопереходов ${st.switchedFails}` : "";
      lines.push(`   постов ${st.posts} · 👍 ${st.likes} · 👎 ${st.dislikes} · рейтинг ${rate}${fail}${switched}`);
    } else {
      lines.push("   <i>ещё не использовалась</i>");
    }
  });

  lines.push("");
  lines.push(current === "auto"
    ? "Сейчас: <b>Авто</b> — перебор всех с запасным вариантом"
    : `Сейчас: <b>${escapeHtml(getProviderTitle(providers, current))}</b>`);
  if (current !== "auto") {
    lines.push("<i>Ручной выбор строгий: бот не будет молча заменять эту модель на Cloudflare/NVIDIA. Для перебора всех используйте Авто.</i>");
  }

  return lines.join("\n");
}

function getProviderTitle(providers, id) {
  const idx = providers.findIndex((p) => p.id === id);
  return idx >= 0 ? `Модель ${idx + 1} — ${providers[idx].title}` : id;
}

export function promptsKeyboard(kind, count) {
  const rows = [[
    { text: "➕ Добавить", callback_data: `p|add|${kind}` },
  ]];
  if (count > 0) {
    rows[0].push({ text: "✏️ Изменить", callback_data: `p|editlist|${kind}` });
    rows[0].push({ text: "🗑 Удалить", callback_data: `p|dellist|${kind}` });
  }
  rows.push([
    { text: kind === "weekday" ? "📅 Показать выходные" : "📅 Показать будни",
      callback_data: `p|show|${kind === "weekday" ? "weekend" : "weekday"}` },
  ]);
  rows.push([{ text: "◀️ Назад в меню", callback_data: "nav|menu" }]);
  return { inline_keyboard: rows };
}

export function promptsText(settings, kind) {
  const list = kind === "weekend" ? settings.weekendPrompts : settings.weekdayPrompts;
  const label = kind === "weekend" ? "выходных" : "будней";

  const lines = [`📝 <b>Промпты для ${label}</b>`, ""];

  if (!list || !list.length) {
    lines.push("<i>Список пуст — используется общий промпт:</i>");
    lines.push(`<code>${escapeHtml(String(settings.nimPrompt).slice(0, 200))}</code>`);
  } else {
    list.forEach((p, i) => {
      lines.push(`<b>${i + 1}.</b> <code>${escapeHtml(String(p))}</code>`);
    });
    lines.push("");
    lines.push("<i>Промпт выбирается случайно из списка.</i>");
  }

  return lines.join("\n");
}

// Пользователь прислал .txt — читаем как «характер чата».
export async function handleDocument(message, env, options = {}) {
  const { isChannelPost = false } = options;
  const chatId = String(message.chat.id);
  const userId = message.from?.id;
  const doc = message.document;

  const name = String(doc.file_name || "");
  if (!/\.txt$/i.test(name) && doc.mime_type !== "text/plain") return;

  const role = await getRole(chatId, userId, env, { isChannelPost });
  if (!canEdit(role)) return;

  if (doc.file_size > 100 * 1024) {
    await sendMessage(chatId, "Файл слишком большой. Нужен .txt до 100 КБ.", env);
    return;
  }

  const info = await tg("getFile", { file_id: doc.file_id }, env);
  if (!info.ok) {
    await sendMessage(chatId, "Не удалось получить файл из Telegram.", env);
    return;
  }

  const url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${info.result.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    await sendMessage(chatId, "Не удалось скачать файл.", env);
    return;
  }

  const content = (await response.text()).trim();
  if (!content) {
    await sendMessage(chatId, "Файл пустой.", env);
    return;
  }

  // Файл может быть двух видов: характер чата или общие примеры подписей.
  // Различаем по имени файла и по тому, чего ждёт бот.
  const pending = userId ? await getPending(chatId, userId, env) : null;
  const wantsExamples =
    pending?.action === "load_examples" ||
    /пример|example|подпис/i.test(name);

  if (wantsExamples) {
    const role = await getRole(chatId, userId, env, { isChannelPost });
    if (role !== "owner") {
      await sendMessage(
        chatId,
        "⛔ Примеры общие для всех чатов — загружать может только владелец бота.",
        env
      );
      return;
    }

    const parsed = parseExamples(content);
    if (!parsed.length) {
      await sendMessage(
        chatId,
        "❌ В файле не нашлось примеров.\n\n" +
          "Нужен .txt: по одному примеру на строку либо через пустую строку. " +
          "Строки короче 10 символов и без знаков препинания пропускаются.",
        env
      );
      return;
    }

    await saveExamples(env, parsed);
    if (userId) await clearPending(chatId, userId, env);

    await sendMessage(
      chatId,
      [
        `✅ Примеры загружены из <code>${escapeHtml(name)}</code>`,
        `Распознано: <b>${parsed.length}</b>`,
        "",
        "<i>Первые три:</i>",
        ...parsed.slice(0, 3).map((e) => `• ${escapeHtml(e.slice(0, 100))}`),
        "",
        "Примеры общие для всех чатов. В каждом чате бот пишет своё —",
        "в этой манере, но под характер именно той беседы.",
        "",
        "Посмотреть: /examples · Проверить: /test",
      ].join("\n"),
      env
    );
    return;
  }

  await patchSettings(
    chatId,
    { character: content.slice(0, CHARACTER_LIMIT), aiCaptions: true },
    env
  );
  if (userId) await clearPending(chatId, userId, env);

  await sendMessage(
    chatId,
    [
      `✅ Характер чата загружен из <code>${escapeHtml(name)}</code>`,
      `Символов: <b>${Math.min(content.length, CHARACTER_LIMIT)}</b>`,
      "",
      `<i>${escapeHtml(content.slice(0, 200))}${content.length > 200 ? "…" : ""}</i>`,
      "",
      "🤖 Генерация подписей включена автоматически. Проверить: /test",
    ].join("\n"),
    env
  );
}

export async function handleCommand(message, env, options = {}) {
  const { isChannelPost = false } = options;

  const chatId = String(message.chat.id);
  const userId = message.from?.id;
  const text = (message.text || "").trim();

  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();
  const value = rest.join(" ").trim();

  const isCommand = text.startsWith("/") && KNOWN_COMMANDS.has(command);

  // ── Шаг 2 диалога: пришёл обычный текст, а бот ждёт ответ ────────────
  if (!isCommand) {
    if (!userId) return;
    const pending = await getPending(chatId, userId, env);
    if (!pending) return;                       // не ждём — игнорируем молча
    if (text.startsWith("/")) return;           // другая команда — не ответ

    await clearPending(chatId, userId, env);
    await applyPendingValue(pending, text, chatId, env);
    return;
  }

  await registerChat(chatId, message.chat, env);

  if (command === "/cancel") {
    if (userId) await clearPending(chatId, userId, env);
    await sendMessage(chatId, "Отменено.", env);
    return;
  }

  if (command === "/id") {
    await sendMessage(
      chatId,
      `🆔 <b>Идентификаторы</b>\n\nЧат: <code>${chatId}</code>\nВы: <code>${userId ?? "—"}</code>`,
      env
    );
    return;
  }

  const role = await getRole(chatId, userId, env, { isChannelPost });

  // ── Дни рождения ────────────────────────────────────────────────────
  // Свой день рождения может назначить сам участник. За другого — только
  // админ чата или владелец бота, ответом на сообщение этого участника.
  if (command === "/birthday" || command === "/birthday_remove" || command === "/birthdays") {
    await handleBirthdayCommand(command, value, message, chatId, userId, role, env);
    return;
  }

  // ── Пользовательские праздники чата ─────────────────────────────────
  if (command === "/holiday" || command === "/holiday_remove" || command === "/holidays") {
    if (!canEdit(role)) {
      await sendMessage(chatId, "⛔ Праздники чата может менять администратор чата или участник с выданным доступом.", env);
      return;
    }
    await handleHolidayCommand(command, value, chatId, env);
    return;
  }

  // ── Статистика: только владельцы бота ────────────────────────────────
  if (
    command.startsWith("/stats") ||
    command === "/export_csv" ||
    command === "/nim_health" ||
    command === "/chats" ||
    command === "/usage" ||
    command === "/change" ||
    command === "/examples" ||
    command === "/examples_clear"
  ) {
    if (role !== "owner") {
      await sendMessage(chatId, "⛔ Эта команда доступна только владельцам бота.", env);
      return;
    }
    if (command === "/usage") {
      await sendMessage(chatId, await usageText(env, escapeHtml), env);
      return;
    }
    if (command === "/examples") {
      const list = await getExamples(env);
      // Помечаем ожидание: следующий .txt уйдёт в примеры, а не в характер.
      if (userId) await setPending(chatId, userId, "load_examples", env);
      await sendMessage(chatId, examplesText(list, escapeHtml), env);
      return;
    }
    if (command === "/examples_clear") {
      await clearExamples(env);
      await sendMessage(chatId, "🗑 Примеры удалены. Подписи снова пишутся без образца.", env);
      return;
    }
    if (command === "/change") {
      // Раньше исключение улетало в route() и бот молча ничего не слал.
      // Теперь причина видна прямо в чате.
      try {
        await sendMessage(
          chatId,
          await changeText(env, listChats, getSettings, 0),
          env,
          { reply_markup: await changeKeyboard(env, listChats, getSettings, 0) }
        );
      } catch (e) {
        await sendMessage(
          chatId,
          `❌ /change упал: <code>${escapeHtml(String(e.message || e).slice(0, 300))}</code>`,
          env
        );
      }
      return;
    }
    await handleStatsCommand(command, value, chatId, env);
    return;
  }

  if (command === "/start" || command === "/help") {
    await sendMessage(chatId, helpText(role), env);
    return;
  }

  if (command === "/settings") {
    const s = await getSettings(chatId, env);
    await sendMessage(chatId, settingsText(s, chatId, role), env);
    return;
  }

  if (command === "/access") {
    const granted = await listGranted(chatId, env);
    const lines = granted.length
      ? granted.map(([id, info]) =>
          `• ${info.username ? "@" + escapeHtml(info.username) : "id " + id} <code>${id}</code>`)
      : ["<i>Никому дополнительно не выдано.</i>"];
    await sendMessage(
      chatId,
      [
        "🔑 <b>Доступ к настройкам</b>",
        "",
        `Ваша роль: <b>${roleLabel(role)}</b>`,
        "",
        "<b>Администраторы чата</b> — полный доступ автоматически.",
        "",
        "<b>Выдан вручную:</b>",
        ...lines,
        "",
        "Выдать: ответьте на сообщение участника командой /grant",
        "Забрать: ответьте на его сообщение командой /revoke",
      ].join("\n"),
      env
    );
    return;
  }

  // ── Выдача прав ──────────────────────────────────────────────────────
  if (command === "/grant" || command === "/revoke") {
    if (!canGrant(role)) {
      await sendMessage(chatId, "⛔ Выдавать права может только администратор чата.", env);
      return;
    }

    const target = message.reply_to_message?.from;
    if (!target) {
      await sendMessage(
        chatId,
        `Ответьте этой командой на сообщение участника.\n\n<i>Пример: пользователь пишет в чат, вы делаете reply и отправляете ${command}</i>`,
        env
      );
      return;
    }
    if (target.is_bot) {
      await sendMessage(chatId, "Ботам права не выдаются.", env);
      return;
    }

    const name = target.username ? "@" + target.username : (target.first_name || String(target.id));

    if (command === "/grant") {
      await grantUser(chatId, target.id, target.username, env);
      await sendMessage(chatId, `✅ ${escapeHtml(name)} теперь может менять настройки бота в этом чате.`, env);
    } else {
      const existed = await revokeUser(chatId, target.id, env);
      await sendMessage(
        chatId,
        existed
          ? `🚫 Права ${escapeHtml(name)} отозваны.`
          : `У ${escapeHtml(name)} и так не было выданных прав.`,
        env
      );
    }
    return;
  }

  // ── Дальше только те, кто может менять настройки ──────────────────────
  if (!canEdit(role)) {
    await sendMessage(
      chatId,
      "⛔ Настройки может менять администратор чата или участник с выданным доступом (/access).",
      env
    );
    return;
  }

  if (command === "/diag") {
    await runDiagnostics(chatId, env);
    return;
  }

  switch (command) {
    case "/set_source": {
      if (!value) {
        const s = await getSettings(chatId, env);
        await sendMessage(chatId, "Выберите источник картинок:", env, {
          reply_markup: sourceKeyboard(s.source),
        });
        return;
      }
      if (!["gdrive", "nim", "search", "mixed"].includes(value)) {
        await sendMessage(chatId, "Использование: <code>/set_source gdrive|nim|search|mixed</code>", env);
        return;
      }
      if (value === "search") {
        const s = await patchSettings(chatId, { source: "search" }, env);
        await setPending(chatId, userId, "set_search", env);
        await sendMessage(chatId, PENDING_PROMPTS.set_search, env, {
          reply_markup: searchFallbackKeyboard(s.searchFallback || "nim"),
        });
        return;
      }
      await patchSettings(chatId, { source: value }, env);
      await sendMessage(chatId, `✅ Источник картинок: <b>${value}</b>`, env);
      return;
    }

    case "/set_gdrive": {
      if (!value) {
        await setPending(chatId, userId, "set_gdrive", env);
        await sendMessage(chatId, PENDING_PROMPTS.set_gdrive, env);
        return;
      }
      await applyGdrive(value, chatId, env);
      return;
    }

    case "/refresh_gdrive": {
      const s = await getSettings(chatId, env);
      const folderId = parseFolderId(s.gdriveFolder);
      if (!folderId) {
        await sendMessage(chatId, "Папка не настроена. Используйте /set_gdrive", env);
        return;
      }
      try {
        const files = await listImages(folderId, env, true);
        const gifs = files.filter((f) => f.mimeType === "image/gif").length;
        const vids = files.filter((f) => String(f.mimeType).startsWith("video/")).length;
        await sendMessage(
          chatId,
          `♻️ Кэш обновлён. Файлов: <b>${files.length}</b>\n` +
            `картинки ${files.length - gifs - vids} · GIF ${gifs} · видео ${vids}`,
          env
        );
      } catch (e) {
        await sendMessage(chatId, `❌ <code>${escapeHtml(String(e).slice(0, 300))}</code>`, env);
      }
      return;
    }

    case "/set_search": {
      if (!value) {
        await setPending(chatId, userId, "set_search", env);
        await sendMessage(chatId, PENDING_PROMPTS.set_search, env);
        return;
      }
      await applySearchQuery(value, chatId, env);
      return;
    }

    case "/searches": {
      const s = await getSettings(chatId, env);
      await sendMessage(chatId, `<pre>${escapeHtml(searchListsText(s))}</pre>`, env);
      return;
    }

    case "/add_search": {
      const parts = value.split(/\s+/);
      const kind = parts[0] === "weekend" ? "weekend" : parts[0] === "weekday" ? "weekday" : null;
      const body = kind ? parts.slice(1).join(" ").trim() : value;
      if (!kind) {
        await sendMessage(chatId, "Куда добавить запрос?\n\n<code>/add_search weekday кот работяга</code>\n<code>/add_search weekend кот отдыхает с кофе</code>", env);
        return;
      }
      if (!body) {
        await setPending(chatId, userId, `add_search_${kind}`, env);
        await sendMessage(chatId, PENDING_PROMPTS[`add_search_${kind}`], env);
        return;
      }
      await addSearchQuery(kind, body, chatId, env);
      return;
    }

    case "/del_search": {
      const parts = value.split(/\s+/);
      const kind = parts[0] === "weekend" ? "weekend" : "weekday";
      const num = Number(parts[1]);
      if (!num) {
        await sendMessage(chatId, "Использование: <code>/del_search weekday 2</code> или <code>/del_search weekend 1</code>\n\nСписок: /searches", env);
        return;
      }
      await deleteSearchQuery(kind, num - 1, chatId, env);
      return;
    }

    // ── Промпты ────────────────────────────────────────────────────────
    case "/prompts": {
      const s = await getSettings(chatId, env);
      if (["all", "все", "both"].includes(value.toLowerCase())) {
        await sendMessage(chatId, `<pre>${escapeHtml(promptListsText(s))}</pre>`, env);
        return;
      }
      const kind = value === "weekend" ? "weekend" : "weekday";
      const list = kind === "weekend" ? s.weekendPrompts : s.weekdayPrompts;
      await sendMessage(chatId, promptsText(s, kind), env, {
        reply_markup: promptsKeyboard(kind, (list || []).length),
      });
      return;
    }

    case "/add_prompt": {
      const parts = value.split(/\s+/);
      const kind = parts[0] === "weekend" ? "weekend" : parts[0] === "weekday" ? "weekday" : null;
      const body = kind ? parts.slice(1).join(" ").trim() : value;

      if (!kind) {
        await sendMessage(
          chatId,
          "Куда добавить промпт?\n\n<code>/add_prompt weekday текст</code>\n<code>/add_prompt weekend текст</code>\n\nИли откройте /prompts и нажмите «Добавить».",
          env
        );
        return;
      }
      // Спрашиваем отдельным сообщением, только если текста нет совсем.
      // Раньше порог < 5 отклонял короткие, но осмысленные промпты («горы»).
      if (!body) {
        await setPending(chatId, userId, `add_prompt_${kind}`, env);
        await sendMessage(chatId, PENDING_PROMPTS[`add_prompt_${kind}`], env);
        return;
      }
      await addPrompt(kind, body, chatId, env);
      return;
    }

    case "/edit_prompt": {
      const parts = value.split(/\s+/);
      const kind = parts[0] === "weekend" ? "weekend" : "weekday";
      const num = Number(parts[1]);
      const newText = parts.slice(2).join(" ").trim();

      if (!num) {
        await sendMessage(
          chatId,
          "Использование: <code>/edit_prompt weekday 2 новый текст</code>\n\n" +
            "Номера смотрите в /prompts. Можно и кнопкой «✏️ Изменить».",
          env
        );
        return;
      }
      if (!newText) {
        // текст не указан — спросим следующим сообщением
        await setPending(chatId, userId, `edit_prompt_${kind}_${num - 1}`, env);
        const st = await getSettings(chatId, env);
        const cur = (kind === "weekend" ? st.weekendPrompts : st.weekdayPrompts)?.[num - 1];
        if (!cur) {
          await sendMessage(chatId, "Нет промпта с таким номером. Смотрите /prompts", env);
          return;
        }
        await sendMessage(
          chatId,
          `✏️ Текущий текст промпта <b>${num}</b>:\n<code>${escapeHtml(cur)}</code>\n\n` +
            "Пришлите новый текст следующим сообщением.\n\n<i>/cancel — отмена</i>",
          env
        );
        return;
      }
      await editPrompt(kind, num - 1, newText, chatId, env);
      return;
    }

    case "/del_prompt": {
      const parts = value.split(/\s+/);
      const kind = parts[0] === "weekend" ? "weekend" : "weekday";
      const num = Number(parts[1]);
      if (!num) {
        await sendMessage(
          chatId,
          "Использование: <code>/del_prompt weekday 2</code>\n\nНомера смотрите в /prompts",
          env
        );
        return;
      }
      await deletePrompt(kind, num - 1, chatId, env);
      return;
    }

    case "/set_prompt": {
      if (value.length < 5) {
        await sendMessage(
          chatId,
          "Использование: <code>/set_prompt текст</code>\n\nЭто общий запасной промпт. Для списков используйте /prompts",
          env
        );
        return;
      }
      await patchSettings(chatId, { nimPrompt: value.slice(0, 1500) }, env);
      await sendMessage(chatId, "✅ Общий промпт сохранён.", env);
      return;
    }

    case "/models": {
      const s = await getSettings(chatId, env);
      const keyCount = getApiKeys(env).length;
      const providers = getAllProviders(env); // NVIDIA + свои из IMAGE_PROVIDERS_JSON

      let stats = {};
      try {
        stats = await votesByProvider(env, chatId);
      } catch {
        stats = {};
      }

      await sendMessage(
        chatId,
        modelsText(providers, s.nimModel, stats, keyCount),
        env,
        { reply_markup: modelsKeyboard(providers, s.nimModel, stats) }
      );
      return;
    }

    case "/style": {
      const s = await getSettings(chatId, env);
      if (!value) {
        await sendMessage(chatId, stylesText(s.imageStyle, escapeHtml), env, {
          reply_markup: stylesKeyboard(s.imageStyle),
        });
        return;
      }
      if (!STYLES[value]) {
        await sendMessage(chatId, "Неизвестный стиль. Откройте /style без аргументов.", env);
        return;
      }
      await patchSettings(chatId, { imageStyle: value }, env);
      await sendMessage(chatId, `✅ Стиль: <b>${getStyle(value).title}</b>`, env);
      return;
    }

    case "/menu": {
      const s = await getSettings(chatId, env);
      await sendMessage(chatId, "📋 <b>Меню бота</b>\n\nВыберите раздел:", env, {
        reply_markup: menuKeyboard(s),
      });
      return;
    }

    case "/set_character": {
      if (!value) {
        await setPending(chatId, userId, "set_character", env);
        const cur = (await getSettings(chatId, env)).character;
        await sendMessage(
          chatId,
          [
            "🎭 <b>Характер чата</b>",
            "",
            cur ? `Сейчас (${cur.length} симв.):\n<i>${escapeHtml(cur)}</i>` : "<i>Пока не задан.</i>",
            "",
            "Пришлите описание следующим сообщением — или отправьте .txt файлом.",
            "",
            "<i>Например: «Чат разработчиков, много шуток про дедлайны, неформальный тон».</i>",
            "",
            "<i>/cancel — отмена</i>",
          ].join("\n"),
          env
        );
        return;
      }
      // Раньше характер сохранялся, но подписи оставались шаблонными,
      // пока пользователь не вспомнит про /ai_on. Включаем сразу.
      await patchSettings(
        chatId,
        { character: value.slice(0, CHARACTER_LIMIT), aiCaptions: true },
        env
      );
      await sendMessage(
        chatId,
        `✅ Характер чата сохранён (${Math.min(value.length, CHARACTER_LIMIT)} симв.).` +
          (value.length > CHARACTER_LIMIT ? `\n⚠️ Текст обрезан до ${CHARACTER_LIMIT} символов.` : "") +
          "\n\n🤖 Генерация подписей <b>включена автоматически</b>.\n" +
          "Выключить: /ai_off · Проверить: /test",
        env
      );
      return;
    }

    case "/caption_style": {
      const s = await getSettings(chatId, env);
      if (!value) {
        await setPending(chatId, userId, "set_caption_traits", env);
        await sendMessage(chatId, captionStylesText(s), env, {
          reply_markup: captionStylesKeyboard(),
        });
        return;
      }
      if (["clear", "off", "очистить", "сброс"].includes(value.toLowerCase())) {
        await patchSettings(chatId, { captionTraits: [] }, env);
        await sendMessage(chatId, "🗑 Характеристики AI-подписей очищены.", env);
        return;
      }
      const traits = parseCaptionTraits(value);
      if (!traits.length) {
        await sendMessage(chatId, PENDING_PROMPTS.set_caption_traits, env);
        return;
      }
      await patchSettings(chatId, { captionTraits: traits, aiCaptions: true }, env);
      await sendMessage(chatId, `✅ Характеристики сохранены: <b>${escapeHtml(captionTraitsLabel(traits))}</b>. AI-подписи включены.`, env);
      return;
    }

    case "/set_text_provider": {
      const allowed = ["gemini", "auto", "external", "cf"];
      if (!value || !allowed.includes(value)) {
        await sendMessage(
          chatId,
          "Использование: <code>/set_text_provider gemini|auto|external|cf</code>\n\n" +
            "<b>gemini</b> — сейчас рекомендовано: текст строго через Gemini, без NVIDIA/Cloudflare fallback.\n" +
            "<b>auto</b> — Gemini → внешний API → Cloudflare.\n" +
            "<b>external</b> — TEXT_API_URL/TEXT_API_KEY/TEXT_API_MODEL.\n" +
            "<b>cf</b> — Cloudflare Workers AI.",
          env
        );
        return;
      }
      await patchSettings(chatId, { textProvider: value, aiCaptions: true }, env);
      await sendMessage(chatId, `✅ Провайдер текста: <b>${escapeHtml(textProviderLabel(value))}</b>. AI-подписи включены.`, env);
      return;
    }

    case "/ai_on":
    case "/ai_off": {
      const on = command === "/ai_on";
      await patchSettings(chatId, { aiCaptions: on }, env);
      await sendMessage(
        chatId,
        on
          ? "✅ Подписи будет писать нейросеть под характер чата.\n\nПроверить: /test"
          : "⛔ Подписи снова берутся из готовых фраз.",
        env
      );
      return;
    }

    case "/set_model": {
      if (!value) {
        const s = await getSettings(chatId, env);
        await sendMessage(chatId, "Выберите модель:", env, {
          reply_markup: modelsKeyboard(getAllProviders(env), s.nimModel),
        });
        return;
      }
      if (value !== "auto" && !getProvider(value, env)) {
        await sendMessage(chatId, "Неизвестная модель. Список: /models", env);
        return;
      }
      await patchSettings(chatId, { nimModel: value }, env);
      await sendMessage(chatId, `✅ Модель: <b>${value}</b>`, env);
      return;
    }

    case "/set_timezone": {
      const tzHelp = [
        "🌍 <b>Часовой пояс</b>",
        "",
        "Пробелы заменяются на <b>подчёркивание</b>:",
        "<code>/set_timezone America/New_York</code>",
        "<code>/set_timezone America/Los_Angeles</code>",
        "<code>/set_timezone America/Sao_Paulo</code>",
        "<code>/set_timezone Europe/Moscow</code>",
        "<code>/set_timezone Europe/Minsk</code>",
        "<code>/set_timezone Asia/Almaty</code>",
        "",
        "<i>«America/New York» с пробелом не сработает — нужно New_York.</i>",
      ].join("\n");

      if (!value) {
        await sendMessage(chatId, tzHelp, env);
        return;
      }
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
      } catch {
        await sendMessage(
          chatId,
          `❌ Пояс <code>${escapeHtml(value)}</code> не распознан.\n\n` +
            (value.includes(" ") ? "Похоже, в названии пробел — замените его на <b>_</b>\n\n" : "") +
            tzHelp,
          env
        );
        return;
      }
      await patchSettings(chatId, { timezone: value }, env);
      const now = localParts(value);
      await sendMessage(
        chatId,
        `✅ Часовой пояс: <b>${value}</b>\nСейчас там: ${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}`,
        env
      );
      return;
    }

    case "/set_weekday_time":
    case "/set_weekend_time": {
      const field = command === "/set_weekday_time" ? "weekdayTime" : "weekendTime";
      const kind = command === "/set_weekday_time" ? "set_weekday_time" : "set_weekend_time";

      if (!value) {
        await setPending(chatId, userId, kind, env);
        await sendMessage(chatId, PENDING_PROMPTS[kind], env);
        return;
      }
      if (!parseTimeSpec(value)) {
        await sendMessage(chatId, "Формат: <code>09:00</code> или диапазон <code>09:00-09:40</code>", env);
        return;
      }
      await patchSettings(chatId, { [field]: value }, env);
      await sendMessage(chatId, `✅ Сохранено: <b>${value}</b>`, env);
      return;
    }

    case "/voting_on":
    case "/voting_off": {
      const on = command === "/voting_on";
      await patchSettings(chatId, { votingEnabled: on }, env);
      await sendMessage(chatId, on ? "✅ Голосование включено." : "⛔ Голосование выключено.", env);
      return;
    }

    case "/enable":
    case "/disable": {
      const on = command === "/enable";
      await patchSettings(chatId, { enabled: on }, env);
      await sendMessage(chatId, on ? "✅ Рассылка включена." : "⛔ Рассылка выключена.", env);
      return;
    }

    case "/test": {
      const s = await getSettings(chatId, env);
      if (value) {
        await sendMessage(
          chatId,
          "Теперь тест выбирается кнопками. Отправьте <code>/test</code> — я покажу список будних и выходных промптов и кнопки для проверки.",
          env
        );
        return;
      }
      await sendMessage(chatId, testPromptsText(s), env, {
        reply_markup: testPromptsKeyboard(s),
      });
      return;
    }

    case "/reset": {
      const s = await getSettings(chatId, env);
      await patchSettings(
        chatId,
        { ...structuredClone(DEFAULT_SETTINGS), title: s.title, grantedUsers: s.grantedUsers || {} },
        env
      );
      await sendMessage(chatId, "♻️ Настройки сброшены (права доступа сохранены).", env);
      return;
    }
  }
}

// ── Применение отложенного ответа ──────────────────────────────────────
async function applyPendingValue(pending, text, chatId, env) {
  // edit_prompt_<kind>_<index> — редактирование конкретного промпта
  const edit = /^edit_prompt_(weekday|weekend)_(\d+)$/.exec(pending.action || "");
  if (edit) {
    return editPrompt(edit[1], Number(edit[2]), text, chatId, env);
  }

  switch (pending.action) {
    case "set_gdrive":
      return applyGdrive(text, chatId, env);

    case "set_search":
      return applySearchQuery(text, chatId, env);

    case "set_caption_traits":
      return applyCaptionTraits(text, chatId, env);

    case "add_search_weekday":
      return addSearchQuery("weekday", text, chatId, env);

    case "add_search_weekend":
      return addSearchQuery("weekend", text, chatId, env);

    case "add_prompt_weekday":
      return addPrompt("weekday", text, chatId, env);

    case "add_prompt_weekend":
      return addPrompt("weekend", text, chatId, env);

    case "set_character": {
      await patchSettings(
        chatId,
        { character: text.slice(0, CHARACTER_LIMIT), aiCaptions: true },
        env
      );
      await sendMessage(
        chatId,
        `✅ Характер чата сохранён (${Math.min(text.length, CHARACTER_LIMIT)} симв.).` +
          (text.length > CHARACTER_LIMIT ? `\n⚠️ Текст обрезан до ${CHARACTER_LIMIT} символов.` : "") +
          "\n\n🤖 Генерация подписей <b>включена автоматически</b>.\n" +
          "Выключить: /ai_off · Проверить: /test",
        env
      );
      return;
    }

    case "set_weekday_time":
    case "set_weekend_time": {
      const field = pending.action === "set_weekday_time" ? "weekdayTime" : "weekendTime";
      if (!parseTimeSpec(text)) {
        await sendMessage(chatId, "Не понял формат. Нужно <code>09:00</code> или <code>09:00-09:40</code>. Попробуйте команду снова.", env);
        return;
      }
      await patchSettings(chatId, { [field]: text }, env);
      await sendMessage(chatId, `✅ Сохранено: <b>${text}</b>`, env);
      return;
    }
  }
}

async function addSearchQuery(kind, textValue, chatId, env) {
  const query = String(textValue || "").trim().replace(/\s+/g, " ").slice(0, 120);
  if (query.length < 2) {
    await sendMessage(chatId, "❌ Запрос слишком короткий. Пример: <code>/add_search weekday кот работяга</code>", env);
    return;
  }

  const s = await getSettings(chatId, env);
  const field = kind === "weekend" ? "weekendSearchQueries" : "weekdaySearchQueries";
  const list = [...(s[field] || [])];
  if (list.length >= 20) {
    await sendMessage(chatId, "Достигнут лимит в 20 поисковых запросов. Удалите лишние через /del_search", env);
    return;
  }
  list.push(query);
  await patchSettings(chatId, { [field]: list, source: "search" }, env);
  await sendMessage(chatId, `✅ Поисковый запрос добавлен в список ${kind === "weekend" ? "выходных" : "будней"}: <code>${escapeHtml(query)}</code>\n\nСписок: /searches`, env);
}

async function deleteSearchQuery(kind, index, chatId, env) {
  const s = await getSettings(chatId, env);
  const field = kind === "weekend" ? "weekendSearchQueries" : "weekdaySearchQueries";
  const list = [...(s[field] || [])];
  if (index < 0 || index >= list.length) {
    await sendMessage(chatId, "Нет поискового запроса с таким номером. Список: /searches", env);
    return;
  }
  const [removed] = list.splice(index, 1);
  await patchSettings(chatId, { [field]: list }, env);
  await sendMessage(chatId, `🗑 Удалён поисковый запрос: <code>${escapeHtml(removed)}</code>`, env);
}

async function applyCaptionTraits(text, chatId, env) {
  const traits = parseCaptionTraits(text);
  if (!traits.length) {
    await sendMessage(chatId, "❌ Не нашёл характеристик. Напишите по одной на строку: <code>ироничные\nинженеры\nдобрые</code>", env);
    return;
  }

  await patchSettings(chatId, { captionTraits: traits, aiCaptions: true }, env);
  await sendMessage(
    chatId,
    "✅ Характеристики для AI-подписей сохранены:\n" +
      traits.map((t) => `• ${escapeHtml(t)}`).join("\n") +
      "\n\n🤖 AI-подписи включены. Проверить: /test",
    env
  );
}

async function handleHolidayCommand(command, value, chatId, env) {
  const s = await getSettings(chatId, env);
  const holidays = { ...(s.holidays || {}) };

  if (command === "/holidays") {
    const list = Object.entries(holidays).sort((a, b) => a[0].localeCompare(b[0]));
    if (!list.length) {
      await sendMessage(chatId, "🎉 Свои праздники чата пока не заданы.\n\nДобавить: <code>/holiday 31.12 Предновогодний день</code>\nУдалить: <code>/holiday_remove 31.12</code>", env);
      return;
    }
    await sendMessage(
      chatId,
      "🎉 <b>Праздники этого чата</b>\n\n" +
        list.map(([date, h]) => {
          const name = typeof h === "string" ? h : h.name;
          const isWeekend = typeof h === "string" ? true : h.isWeekend === true;
          return `• <b>${formatBirthdayDate(date)}</b> — ${escapeHtml(name)} (${isWeekend ? "выходной" : "будний"})`;
        }).join("\n"),
      env
    );
    return;
  }

  if (command === "/holiday_remove") {
    const date = parseBirthdayDate(value);
    if (!date) {
      await sendMessage(chatId, "Использование: <code>/holiday_remove 31.12</code>\n\nСписок: /holidays", env);
      return;
    }
    const old = holidays[date];
    delete holidays[date];
    await patchSettings(chatId, { holidays }, env);
    await sendMessage(chatId, old ? `🗑 Праздник ${formatBirthdayDate(date)} удалён.` : "Такого праздника не было.", env);
    return;
  }

  const parts = value.split(/\s+/);
  const date = parseBirthdayDate(parts[0]);
  const name = parts.slice(1).join(" ").trim().slice(0, 80);
  if (!date || !name) {
    await sendMessage(chatId, "Использование: <code>/holiday 31.12 Предновогодний день</code>\n\nПосле добавления бот спросит, оставить день будним или считать выходным.", env);
    return;
  }

  holidays[date] = { name, isWeekend: false };
  await patchSettings(chatId, { holidays }, env);
  await sendMessage(
    chatId,
    `✅ Праздник добавлен: <b>${formatBirthdayDate(date)}</b> — ${escapeHtml(name)}.\n\n` +
      "Как считать этот день в расписании?",
    env,
    { reply_markup: holidayModeKeyboard(date, false) }
  );
}

async function handleBirthdayCommand(command, value, message, chatId, userId, role, env) {
  if (command === "/birthdays") {
    const s = await getSettings(chatId, env);
    const list = Object.entries(s.birthdays || {}).sort((a, b) => String(a[1].date).localeCompare(String(b[1].date)));
    if (!list.length) {
      await sendMessage(chatId, "🎂 Дни рождения пока не заданы.\n\nСвой: <code>/birthday 08.03</code>\nЗа другого: reply + <code>/birthday 08.03</code> (админ/владелец)", env);
      return;
    }

    const lines = list.map(([id, b]) =>
      `• <b>${formatBirthdayDate(b.date)}</b> — ${escapeHtml(b.username ? "@" + b.username : b.name || id)} <code>${id}</code>`
    );
    await sendMessage(chatId, `🎂 <b>Дни рождения этого чата</b>\n\n${lines.join("\n")}`, env);
    return;
  }

  if (!userId) return;

  const target = message.reply_to_message?.from || message.from;
  const isSelf = String(target?.id) === String(userId);
  if (!isSelf && !canGrant(role)) {
    await sendMessage(chatId, "⛔ За другого участника день рождения может назначить только админ чата или владелец бота. Ответьте командой на сообщение участника.", env);
    return;
  }
  if (target?.is_bot) {
    await sendMessage(chatId, "Ботам день рождения не назначаем.", env);
    return;
  }

  const s = await getSettings(chatId, env);
  const birthdays = { ...(s.birthdays || {}) };

  if (command === "/birthday_remove") {
    delete birthdays[String(target.id)];
    await patchSettings(chatId, { birthdays }, env);
    await sendMessage(chatId, `🗑 День рождения для ${escapeHtml(target.username ? "@" + target.username : target.first_name || String(target.id))} удалён.`, env);
    return;
  }

  const date = parseBirthdayDate(value);
  if (!date) {
    await sendMessage(
      chatId,
      "Формат: <code>/birthday ДД.ММ</code>\n\n" +
        "Свой день рождения ставится обычной командой. За другого участника — ответьте на его сообщение: <code>/birthday 08.03</code>.\n" +
        "Удалить: <code>/birthday_remove</code> или reply + <code>/birthday_remove</code>.",
      env
    );
    return;
  }

  birthdays[String(target.id)] = {
    date,
    name: target.first_name || target.username || String(target.id),
    username: target.username || "",
    setBy: String(userId),
    updatedAt: new Date().toISOString(),
  };
  await patchSettings(chatId, { birthdays }, env);

  await sendMessage(
    chatId,
    `✅ День рождения для ${escapeHtml(target.username ? "@" + target.username : target.first_name || String(target.id))}: <b>${formatBirthdayDate(date)}</b>.`,
    env
  );
}

// Проверяет всё, что нужно для работы, и показывает что именно сломано.
async function runDiagnostics(chatId, env) {
  const s = await getSettings(chatId, env);
  const lines = ["🩺 <b>Диагностика этого чата</b>", ""];

  // --- секреты ---
  lines.push("<b>Ключи</b>");
  lines.push(`${env.BOT_TOKEN ? "✅" : "❌"} BOT_TOKEN`);
  lines.push(`${env.GOOGLE_API_KEY ? "✅" : "❌"} GOOGLE_API_KEY`);
  lines.push("✅ Yandex Images: без ключа (неофициальная выдача)");
  lines.push("✅ DuckDuckGo Images: без ключа (неофициальная выдача)");
  lines.push(`${env.PIXABAY_API_KEY ? "✅" : "➖"} Pixabay Images: PIXABAY_API_KEY`);
  lines.push(`${env.PEXELS_API_KEY ? "✅" : "➖"} Pexels Images: PEXELS_API_KEY`);
  lines.push(`${env.SERPER_API_KEY ? "✅" : "➖"} Serper Images: SERPER_API_KEY`);
  lines.push(`${env.BRAVE_SEARCH_API_KEY ? "✅" : "➖"} Brave Images: BRAVE_SEARCH_API_KEY`);
  lines.push(`${(env.GOOGLE_SEARCH_API_KEY || env.GOOGLE_API_KEY) && (env.GOOGLE_SEARCH_CX || env.GOOGLE_SEARCH_ENGINE_ID || env.GOOGLE_CSE_ID) ? "✅" : "➖"} Google CSE Images: GOOGLE_SEARCH_CX + ключ`);
  lines.push(`Поиск картинок: <code>${escapeHtml(String(env.IMAGE_SEARCH_PROVIDER || "auto"))}</code>`);

  lines.push(`${env.GEMINI_API_KEY ? "✅" : "➖"} GEMINI_API_KEY (Gemini картинки)`);
  lines.push(`${env.AI ? "✅" : "➖"} Cloudflare Workers AI binding`);

  const imgKeys = getApiKeys(env);
  lines.push(`${imgKeys.length ? "✅" : "❌"} NVIDIA картинки: ключей ${imgKeys.length}`);

  const txtKeys = getTextApiKeys(env);
  if (hasDedicatedTextKey(env)) {
    lines.push(`✅ NVIDIA текст: ключей ${txtKeys.length}`);
  } else if (txtKeys.length) {
    lines.push("⚠️ NVIDIA текст: отдельного ключа нет, используются ключи картинок");
  } else {
    lines.push("❌ NVIDIA текст: ключа нет (NVIDIA_TEXT_API_KEY)");
  }
  lines.push(env.GEMINI_API_KEY
    ? `✅ Gemini текст: <code>${escapeHtml(getGeminiTextModel(env))}</code>`
    : "➖ Gemini текст: нет GEMINI_API_KEY");
  lines.push(`Режим текста в этом чате: <b>${escapeHtml(textProviderLabel(s.textProvider || "gemini"))}</b>`);
  lines.push(`OpenAI-compatible текст: <code>${escapeHtml(getTextModel(env))}</code>`);
  lines.push(`Характеристики подписей: <b>${escapeHtml(captionTraitsLabel(s.captionTraits || []))}</b>`);

  if (env.AI) {
    const u = await getUsage(env);
    const pct = ((u.total / FREE_NEURONS_PER_DAY) * 100).toFixed(0);
    lines.push(`⚡ Workers AI сегодня: ${Math.round(u.total)}/${FREE_NEURONS_PER_DAY} нейронов (${pct}%) — /usage`);
  }

  const custom = getCustomProviders(env);
  if (custom.length) {
    lines.push(`✅ Свои провайдеры картинок: ${custom.length}`);
    for (const c of custom) {
      const hasKey = !c.keyEnv || Boolean(env[c.keyEnv]);
      lines.push(`   ${hasKey ? "✅" : "❌"} ${escapeHtml(c.title)}` +
        (c.keyEnv ? ` (ключ ${escapeHtml(c.keyEnv)})` : ""));
    }
  }
  lines.push("");

  // --- Google Drive ---
  lines.push("<b>Google Drive</b>");
  const folderId = parseFolderId(s.gdriveFolder);
  if (!folderId) {
    lines.push("➖ папка не задана (/set_gdrive)");
  } else {
    lines.push(`папка: <code>${escapeHtml(folderId)}</code>`);
    try {
      const files = await listImages(folderId, env, true);
      const gifs = files.filter((f) => f.mimeType === "image/gif").length;
      const vids = files.filter((f) => String(f.mimeType).startsWith("video/")).length;
      const pics = files.length - gifs - vids;

      lines.push(`✅ доступна, файлов: <b>${files.length}</b>`);
      lines.push(`   картинки ${pics} · GIF ${gifs} · видео ${vids}`);
      if (!files.length) lines.push("⚠️ в папке нет подходящих файлов");
    } catch (e) {
      lines.push(`❌ ${escapeHtml(String(e.message || e).slice(0, 300))}`);
    }
  }
  lines.push("");

  // --- промпты ---
  lines.push("<b>Промпты</b>");
  lines.push(`будни: ${(s.weekdayPrompts || []).length}, выходные: ${(s.weekendPrompts || []).length}`);
  lines.push("");

  lines.push("<b>Подписи</b>");
  lines.push(s.aiCaptions ? "🤖 генерирует нейросеть" : "📄 готовые фразы (/ai_on — включить ИИ)");
  lines.push(s.character ? `характер задан (${s.character.length} симв.)` : "характер не задан (/set_character)");
  lines.push("");

  lines.push("<b>Расписание</b>");
  lines.push(`${s.enabled ? "✅ включено" : "⛔ выключено"} · ${s.weekdayTime} / ${s.weekendTime} · ${s.timezone}`);
  lines.push(`дней рождения: <b>${Object.keys(s.birthdays || {}).length}</b>`);
  lines.push(`источник: <b>${s.source}</b>`);

  await sendMessage(chatId, lines.join("\n"), env);
}

async function applySearchQuery(value, chatId, env) {
  const query = String(value || "").trim().replace(/\s+/g, " ").slice(0, 120);
  if (query.length < 2) {
    await sendMessage(chatId, "❌ Запрос слишком короткий. Пример: <code>/set_search кот работяга</code>", env);
    return;
  }

  await patchSettings(chatId, { searchQuery: query, source: "search" }, env);
  await sendMessage(
    chatId,
    "✅ Поиск картинок включён.\n" +
      `Запрос: <code>${escapeHtml(query)}</code>\n\n` +
      "Буду брать каждый раз новую картинку без повторов из выдачи. " +
      "18+ фильтр включён на стороне поиска и дополнительно проверяется по результатам.\n\n" +
      "⚠️ Поиск неофициальный, поэтому выберите второй способ на случай сбоя кнопкой ниже.", 
    env,
    { reply_markup: searchFallbackKeyboard((await getSettings(chatId, env)).searchFallback || "nim") }
  );
}

async function applyGdrive(value, chatId, env) {
  const folderId = parseFolderId(value);
  if (!folderId) {
    await sendMessage(
      chatId,
      "Не похоже на ссылку Google Drive.\nНужно вида <code>https://drive.google.com/drive/folders/…</code>",
      env
    );
    return;
  }
  try {
    const files = await listImages(folderId, env, true);
    await patchSettings(chatId, { gdriveFolder: value }, env);
    await sendMessage(
      chatId,
      `✅ Папка подключена.\nНайдено изображений: <b>${files.length}</b>` +
        (files.length ? "" : "\n\n⚠️ В папке нет картинок — проверьте содержимое."),
      env
    );
  } catch (e) {
    // Текст ошибки уже содержит конкретную причину и подсказку (см. gdrive.js)
    await sendMessage(
      chatId,
      `❌ Не удалось прочитать папку.\n\n${escapeHtml(String(e.message || e).slice(0, 400))}`,
      env
    );
  }
}

export async function addPrompt(kind, textValue, chatId, env) {
  const s = await getSettings(chatId, env);
  const field = kind === "weekend" ? "weekendPrompts" : "weekdayPrompts";
  const list = [...(s[field] || [])];

  if (list.length >= 20) {
    await sendMessage(chatId, "Достигнут лимит в 20 промптов. Удалите лишние через /prompts", env);
    return;
  }

  // 1500 символов с запасом. Реальное ограничение — у самих моделей:
  // CLIP (SDXL, SD3, BRIA) читает только первые ~77 токенов, остальное
  // молча отбрасывает. FLUX на T5 понимает до 512 токенов.
  const MAX_PROMPT_CHARS = 1500;
  const trimmed = String(textValue || "").trim().slice(0, MAX_PROMPT_CHARS);

  // Пустой промпт сохранять нельзя: он давал "no_image" и мусор в переводе.
  if (trimmed.length < 3) {
    await sendMessage(
      chatId,
      "❌ Промпт слишком короткий. Нужно хотя бы 3 символа.\n\n" +
        "Пример: <code>/add_prompt weekday закат над горами, тёплый свет</code>",
      env
    );
    return;
  }

  list.push(trimmed);
  await patchSettings(chatId, { [field]: list }, env);

  const notes = [];

  if (textValue.length > MAX_PROMPT_CHARS) {
    notes.push(`✂️ Промпт обрезан до ${MAX_PROMPT_CHARS} символов.`);
  }
  if (needsTranslation(trimmed)) {
    notes.push(
      "🌐 Промпт на русском — переведу на английский перед генерацией.\n" +
      "Модели понимают только английский, перевод кэшируется."
    );
  }

  // ~1.3 токена на слово — грубая, но достаточная оценка для предупреждения
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  if (Math.ceil(words * 1.3) > 70) {
    notes.push(
      `⚠️ Промпт длинный (~${words} слов). Модели на CLIP (SDXL, SD3, BRIA)\n` +
      "читают только первые ~77 токенов, остальное отбросят.\n" +
      "FLUX понимает длинные промпты — выберите его в /models."
    );
  }

  await sendMessage(
    chatId,
    `✅ Промпт добавлен в список ${kind === "weekend" ? "выходных" : "будней"} (всего ${list.length}).` +
      (notes.length ? "\n\n<i>" + notes.join("\n\n") + "</i>" : ""),
    env,
    { reply_markup: promptsKeyboard(kind, list.length) }
  );
}

export async function editPrompt(kind, index, newText, chatId, env) {
  const s = await getSettings(chatId, env);
  const field = kind === "weekend" ? "weekendPrompts" : "weekdayPrompts";
  const list = [...(s[field] || [])];

  if (index < 0 || index >= list.length) {
    await sendMessage(chatId, "Нет промпта с таким номером. Смотрите /prompts", env);
    return;
  }

  const trimmed = String(newText || "").trim().slice(0, 1500);
  if (trimmed.length < 3) {
    await sendMessage(chatId, "❌ Промпт слишком короткий. Нужно хотя бы 3 символа.", env);
    return;
  }

  const was = list[index];
  list[index] = trimmed;
  await patchSettings(chatId, { [field]: list }, env);

  await sendMessage(
    chatId,
    [
      `✏️ Промпт <b>${index + 1}</b> изменён.`,
      "",
      `<s>${escapeHtml(String(was).slice(0, 150))}</s>`,
      `<code>${escapeHtml(trimmed)}</code>`,
    ].join("\n") +
      (needsTranslation(trimmed)
        ? "\n\n<i>🌐 Переведу на английский перед генерацией.</i>"
        : ""),
    env,
    { reply_markup: promptsKeyboard(kind, list.length) }
  );
}

export async function deletePrompt(kind, index, chatId, env) {
  const s = await getSettings(chatId, env);
  const field = kind === "weekend" ? "weekendPrompts" : "weekdayPrompts";
  const list = [...(s[field] || [])];

  if (index < 0 || index >= list.length) {
    await sendMessage(chatId, "Нет промпта с таким номером. Смотрите /prompts", env);
    return;
  }

  const [removed] = list.splice(index, 1);
  await patchSettings(chatId, { [field]: list }, env);

  await sendMessage(
    chatId,
    `🗑 Удалён: <code>${escapeHtml(String(removed).slice(0, 120))}</code>`,
    env,
    { reply_markup: promptsKeyboard(kind, list.length) }
  );
}

function roleLabel(role) {
  return {
    owner: "владелец бота",
    admin: "администратор чата",
    granted: "доступ выдан админом",
    user: "участник",
  }[role] || role;
}

function helpText(role) {
  const base = [
    "🌅 <b>Good Morning Bot</b>",
    "",
    `Ваша роль: <b>${roleLabel(role)}</b>`,
    "",
    "<b>Настройки этого чата</b>",
    "/menu — меню с кнопками",
    "/settings — текущая конфигурация",
    "/set_source — источник картинок (кнопки)",
    "/set_gdrive — папка Google Drive",
    "/refresh_gdrive — обновить список файлов",
    "/set_search &lt;запрос&gt; — общий поисковый запрос",
    "/searches — списки поисковых запросов",
    "/add_search weekday|weekend &lt;запрос&gt;",
    "/del_search weekday|weekend &lt;номер&gt;",
    "",
    "<b>Промпты</b>",
    "/prompts — список для будней (кнопки)",
    "/prompts weekend — список для выходных",
    "/add_prompt weekday &lt;текст&gt;",
    "/edit_prompt weekday &lt;номер&gt; &lt;текст&gt; — изменить",
    "/del_prompt weekday &lt;номер&gt;",
    "/set_prompt &lt;текст&gt; — общий запасной",
    "",
    "<b>Подписи к картинкам</b>",
    "/set_character — характер чата (текстом или .txt файлом)",
    "/caption_style — короткие характеристики для AI-подписей",
    "/set_text_provider gemini|auto|external|cf — выбрать API текста",
    "/ai_on, /ai_off — писать подписи нейросетью",
    "",
    "<b>Модели и расписание</b>",
    "/models — выбор модели (кнопки)",
    "/style — стиль картинок (кнопки)",
    "/set_timezone Europe/Moscow",
    "/set_weekday_time 09:00 или 09:00-09:40",
    "/set_weekend_time 10:30",
    "",
    "<b>Дни рождения</b>",
    "/birthday 08.03 — указать свой день рождения",
    "/birthday 08.03 — reply на участника, если вы админ/владелец",
    "/birthdays — список",
    "/birthday_remove — удалить свой или reply-цель",
    "",
    "<b>Праздники чата</b>",
    "/holiday 31.12 Название — добавить праздник и выбрать: будний или выходной",
    "/holidays — список праздников чата с режимом дня",
    "/holiday_remove 31.12 — удалить праздник",
    "",
    "<b>Прочее</b>",
    "/voting_on, /voting_off",
    "/enable, /disable — или кнопка в /menu",
    "/test — список промптов с кнопками для теста",
    "/enable — включить утреннюю рассылку",
    "/disable — отключить бота в этом чате, не удаляя его",
    "/reset — сброс настроек чата",
    "/id — узнать ID чата и свой",
    "/diag — проверить, что настроено и что сломано",
    "",
    "<b>Доступ</b>",
    "/access — кто может настраивать",
    "/grant — в ответ на сообщение: выдать права",
    "/revoke — в ответ на сообщение: забрать права",
  ];

  if (role === "owner") {
    base.push(
      "",
      "<b>Статистика (только владельцы)</b>",
      "/stats [дней]",
      "/stats_models [дней]",
      "/stats_chats [дней]",
      "/stats_recent [N]",
      "/stats_post &lt;id&gt;",
      "/stats_errors [N]",
      "/nim_health",
      "/usage — остаток лимита Cloudflare и счётчик Gemini",
      "/change — модели во всех чатах, смена кнопками",
      "/examples — общие примеры подписей (.txt файлом)",
      "/examples_clear — удалить примеры",
      "/chats",
      "/export_csv [дней]"
    );
  }

  return base.join("\n");
}

export function settingsTextPublic(s, chatId, role) {
  return settingsText(s, chatId, role);
}

function settingsText(s, chatId, role) {
  const wd = (s.weekdayPrompts || []).length;
  const we = (s.weekendPrompts || []).length;
  const swd = (s.weekdaySearchQueries || []).length;
  const swe = (s.weekendSearchQueries || []).length;
  const fallback = s.searchFallback === "gdrive" ? "Google Drive" : "генерация ИИ";

  return [
    "⚙️ <b>Настройки этого чата</b>",
    `<i>chat_id: <code>${chatId}</code></i>`,
    "",
    "<b>Состояние</b>",
    `Рассылка: <b>${s.enabled ? "включена ✅" : "выключена ⛔"}</b>` +
      (s.enabled ? "" : " — бот в чате, но по расписанию не пишет"),
    `Голосование: <b>${s.votingEnabled ? "включено" : "выключено"}</b>`,
    "",
    "<b>Картинки</b>",
    `Источник: <b>${s.source}</b> ` +
      (s.source === "gdrive" ? "(Google Drive)" :
       s.source === "nim" ? "(генерация ИИ)" :
       s.source === "search" ? "(поисковый запрос)" : "(Drive + генерация)"),
    `Google Drive: ${s.gdriveFolder ? "подключён ✅" : "не задан ❌"}`,
    `Поиск общий: <code>${escapeHtml(s.searchQuery || "не задан")}</code>`,
    `Поиск будни/выходные: <b>${swd}</b> / <b>${swe}</b> запросов`,
    `Запасной источник для поиска: <b>${fallback}</b>`,
    `Модель генерации: <b>${s.nimModel}</b>`,
    `Стиль картинки: <b>${getStyle(s.imageStyle).title}</b>`,
    "",
    "<b>Промпты генерации</b>",
    `Будни: <b>${wd || "—"}</b>`,
    `Выходные: <b>${we || "—"}</b>`,
    `Общий запасной: <i>${escapeHtml(String(s.nimPrompt).slice(0, 160))}</i>`,
    "",
    "<b>Подписи</b>",
    `AI-подписи: <b>${s.aiCaptions ? "включены 🤖" : "выключены"}</b>`,
    `API текста: <b>${escapeHtml(textProviderLabel(s.textProvider || "gemini"))}</b>`,
    `Характер чата: <b>${s.character ? `${s.character.length} симв.` : "не задан"}</b>`,
    `Короткие характеристики: <b>${escapeHtml(captionTraitsLabel(s.captionTraits || []))}</b>`,
    "",
    "<b>Расписание и даты</b>",
    `Часовой пояс: <b>${s.timezone}</b>`,
    `Будни: <b>${s.weekdayTime}</b>`,
    `Выходные/праздники: <b>${s.weekendTime}</b>`,
    `Дни рождения: <b>${Object.keys(s.birthdays || {}).length}</b>`,
    `Свои праздники чата: <b>${Object.keys(s.holidays || {}).length}</b>`,
    "",
    `Ваша роль: <b>${roleLabel(role)}</b>`,
    "",
    "<i>Настройки индивидуальны для каждого чата. Открыть кнопки: /menu</i>",
  ].filter((line) => line !== null).join("\n");
}
