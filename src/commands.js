import {
  DEFAULT_SETTINGS,
  WEEKDAY_MESSAGES,
  WEEKEND_MESSAGES,
} from "./config.js";
import { sendMessage, sendPhotoBytes, escapeHtml, tg, editMessage } from "./telegram.js";
import { getSettings, patchSettings, registerChat } from "./storage.js";
import { setPending, getPending, clearPending } from "./pending.js";
import { getRole, canEdit, canGrant, grantUser, revokeUser, listGranted } from "./access.js";
import { parseFolderId, getGdriveImage, listImages } from "./images/gdrive.js";
import {
  generateImage,
  NIM_PROVIDERS,
  getProvider,
  getApiKeys,
  getAllProviders,
  getCustomProviders,
} from "./images/nim.js";
import { newPostId, savePost, logAttempts, votesByProvider } from "./db.js";
import { localParts, parseTimeSpec } from "./scheduler.js";
import { handleStatsCommand } from "./stats.js";
import { usageText, getUsage, FREE_NEURONS_PER_DAY } from "./usage.js";
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
  DEFAULT_CHARACTER,
  getTextApiKeys,
  hasDedicatedTextKey,
  getTextModel,
  translatePrompt,
  needsTranslation,
} from "./caption.js";

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Промпт берётся из библиотеки для нужного типа дня.
// Если список пуст — используется одиночный nimPrompt (обратная совместимость).
export function pickPrompt(settings, isWeekend) {
  const list = isWeekend ? settings.weekendPrompts : settings.weekdayPrompts;
  if (Array.isArray(list) && list.length) return pick(list);
  return settings.nimPrompt;
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

export async function sendMorning(chatId, settings, env, options = {}) {
  // forcePrompt: /test заранее показывает промпт пользователю и передаёт
  // его сюда. Без этого pickPrompt вызывался дважды и случайно выбирал
  // РАЗНЫЕ промпты — в превью один, в генерации другой.
  const { test = false, forcePrompt = null } = options;

  const now = localParts(settings.timezone);

  // Подпись: либо генерирует нейросеть под характер чата, либо готовая фраза.
  let text = pick(now.isWeekend ? WEEKEND_MESSAGES : WEEKDAY_MESSAGES);
  let captionSource = "template";
  let captionError = null;

  if (settings.aiCaptions) {
    const generated = await generateCaption(env, {
      character: settings.character || DEFAULT_CHARACTER,
      isWeekend: now.isWeekend,
      chatTitle: settings.title || "",
    });
    if (generated.ok) {
      text = generated.text;
      captionSource = "llm";
    } else {
      // Раньше сбой глотался молча, и было непонятно, почему подписи
      // остаются шаблонными. Теперь причина видна в /test.
      captionError = generated.error || "неизвестная ошибка";
    }
  }

  const caption = test
    ? `🧪 <i>Тестовая отправка</i>\n\n${text}`
    : text;

  const postId = newPostId();
  const folderId = parseFolderId(settings.gdriveFolder);

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

  if (useNim && needsTranslation(rawPrompt)) {
    const tr = await translatePrompt(rawPrompt, env);
    activePrompt = tr.text;
    promptTranslated = tr.translated;
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
    negative = negativeFor(settings.imageStyle, activePrompt);
    const withStyle = applyStyle(activePrompt, settings.imageStyle);
    styleApplied = withStyle !== activePrompt;
    activePrompt = withStyle;
  }

  if (useNim) {
    const result = await generateImage(activePrompt, env, {
      preferred: settings.nimModel,
      chatId,
      negative,
    });
    
    attempts = result.attempts || [];
    if (result.ok) image = result;
    else error = "Все модели NIM недоступны";
  } else if (folderId) {
    try {
      image = await getGdriveImage(chatId, folderId, env, settings.avoidRepeatLast);
    } catch (e) {
      error = String(e);
    }
  } else {
    error = "Источник картинок не настроен";
  }

  // --- запасной источник ---
  if (!image) {
    if (useNim && folderId) {
      try {
        image = await getGdriveImage(chatId, folderId, env, settings.avoidRepeatLast);
      } catch (e) {
        error = `${error}; fallback Drive: ${e}`;
      }
    } else if (!useNim) {
      const result = await generateImage(activePrompt, env, {
        preferred: settings.nimModel,
        chatId,
        negative,
      });
      attempts = attempts.concat(result.attempts || []);
      if (result.ok) image = result;
    }
  }

  await logAttempts(env, chatId, attempts);

  let messageId = null;
  let tgFileId = null;
  let status = "ok";

  if (image) {
    const markup = settings.votingEnabled ? voteKeyboard(postId) : undefined;
    const sent = await sendPhotoBytes(chatId, image.bytes, caption, env, {
      reply_markup: markup,
    });

    if (sent.ok) {
      messageId = sent.result.message_id;
      const photos = sent.result.photo || [];
      tgFileId = photos[photos.length - 1]?.file_id || null;
    } else {
      status = "tg_error";
      error = JSON.stringify(sent).slice(0, 300);
    }
  } else {
    status = "no_image";
    const sent = await sendMessage(
      chatId,
      `${caption}\n\n<i>⚠️ Картинку получить не удалось</i>`,
      env
    );
    if (sent.ok) messageId = sent.result.message_id;
  }

  await savePost(env, {
    id: postId,
    chatId,
    chatTitle: settings.title,
    messageId,
    localDate: now.date,
    isWeekend: now.isWeekend,
    source: image?.provider === "gdrive" ? "gdrive" : useNim ? "nim" : "gdrive",
    provider: image?.provider || null,
    model: image?.model || null,
    prompt: useNim ? activePrompt : null,
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
    prompt: useNim ? activePrompt : null,
    promptOriginal: useNim && promptTranslated ? rawPrompt : null,
    promptTranslated,
    captionSource,
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




const KNOWN_COMMANDS = new Set([
  "/start", "/help", "/settings", "/id",
  "/set_source", "/set_gdrive", "/refresh_gdrive",
  "/prompts", "/set_prompt", "/add_prompt", "/del_prompt", "/edit_prompt",
  "/models", "/set_model", "/set_timezone", "/style",
  "/set_weekday_time", "/set_weekend_time",
  "/voting_on", "/voting_off", "/enable", "/disable",
  "/test", "/reset", "/cancel", "/diag", "/menu",
  "/set_character", "/ai_on", "/ai_off",
  "/grant", "/revoke", "/access",
  "/stats", "/stats_models", "/stats_chats", "/stats_recent",
  "/stats_post", "/stats_errors", "/nim_health", "/chats", "/export_csv", "/usage",
]);

// Команды, которые умеют работать в два шага: сначала вопрос, потом ответ.
const PENDING_PROMPTS = {
  set_gdrive: "Пришлите ссылку на публичную папку Google Drive следующим сообщением.\n\n<i>/cancel — отмена</i>",
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
        { text: `${mark("mixed")}Обе`, callback_data: "s|source|mixed" },
      ],
      [{ text: "◀️ Назад в меню", callback_data: "nav|menu" }],
    ],
  };
}

// Главное меню — единая точка возврата для всех кнопок «Назад».
export function menuKeyboard() {
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
        { text: "⚙️ Настройки", callback_data: "nav|settings" },
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
    const score = st ? ` 👍${st.likes} 👎${st.dislikes}` : "";
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
      lines.push(`   постов ${st.posts} · 👍 ${st.likes} · 👎 ${st.dislikes} · рейтинг ${rate}`);
    } else {
      lines.push("   <i>ещё не использовалась</i>");
    }
  });

  lines.push("");
  lines.push(current === "auto"
    ? "Сейчас: <b>Авто</b> — перебор всех с запасным вариантом"
    : `Сейчас: <b>${escapeHtml(getProviderTitle(providers, current))}</b>`);

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

  await patchSettings(
    chatId,
    { character: content.slice(0, 2000), aiCaptions: true },
    env
  );
  if (userId) await clearPending(chatId, userId, env);

  await sendMessage(
    chatId,
    [
      `✅ Характер чата загружен из <code>${escapeHtml(name)}</code>`,
      `Символов: <b>${Math.min(content.length, 2000)}</b>`,
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

  // ── Статистика: только владельцы бота ────────────────────────────────
  if (
    command.startsWith("/stats") ||
    command === "/export_csv" ||
    command === "/nim_health" ||
    command === "/chats" ||
    command === "/usage"
  ) {
    if (role !== "owner") {
      await sendMessage(chatId, "⛔ Эта команда доступна только владельцам бота.", env);
      return;
    }
    if (command === "/usage") {
      await sendMessage(chatId, await usageText(env, escapeHtml), env);
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
      if (!["gdrive", "nim", "mixed"].includes(value)) {
        await sendMessage(chatId, "Использование: <code>/set_source gdrive|nim|mixed</code>", env);
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
        await sendMessage(chatId, `♻️ Кэш обновлён. Изображений: <b>${files.length}</b>`, env);
      } catch (e) {
        await sendMessage(chatId, `❌ <code>${escapeHtml(String(e).slice(0, 300))}</code>`, env);
      }
      return;
    }

    // ── Промпты ────────────────────────────────────────────────────────
    case "/prompts": {
      const s = await getSettings(chatId, env);
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
      if (body.length < 5) {
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
      await sendMessage(chatId, "📋 <b>Меню бота</b>\n\nВыберите раздел:", env, {
        reply_markup: menuKeyboard(),
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
        { character: value.slice(0, 2000), aiCaptions: true },
        env
      );
      await sendMessage(
        chatId,
        `✅ Характер чата сохранён (${Math.min(value.length, 2000)} симв.).` +
          (value.length > 2000 ? "\n⚠️ Текст обрезан до 2000 символов." : "") +
          "\n\n🤖 Генерация подписей <b>включена автоматически</b>.\n" +
          "Выключить: /ai_off · Проверить: /test",
        env
      );
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
      if (!value) {
        await sendMessage(chatId, "Пример: <code>/set_timezone Europe/Moscow</code>", env);
        return;
      }
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
      } catch {
        await sendMessage(chatId, "Не распознал пояс. Пример: <code>/set_timezone Europe/Moscow</code>", env);
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

      const willUseNim =
        s.source === "nim" || (s.source === "mixed" && true);
      const preview = pickPrompt(s, localParts(s.timezone).isWeekend);

      // Одно служебное сообщение на весь тест: сначала «Готовлю…»,
      // потом ЭТО ЖЕ сообщение редактируется в итоговый отчёт.
      // Раньше слались два отдельных и засоряли чат.
      const statusMsg = await sendMessage(
        chatId,
        [
          "⏳ Готовлю…",
          "",
          `Источник: <b>${s.source}</b>`,
          willUseNim
            ? `Промпт: <i>${escapeHtml(String(preview))}</i>` +
              (needsTranslation(preview) ? "\n<i>(переведу на английский)</i>" : "")
            : "Картинка: случайная из Google Drive",
          `Подпись: ${s.aiCaptions ? "🤖 нейросеть" : "📄 готовая фраза"}`,
          !s.aiCaptions && s.character
            ? "⚠️ <b>Характер задан, но подписи выключены!</b> Включить: /ai_on"
            : null,
        ].filter(Boolean).join("\n"),
        env
      );

      const statusId = statusMsg?.result?.message_id || null;

      const result = await sendMorning(chatId, s, env, { test: true, forcePrompt: preview });

      // Показываем, что реально сработало — видно, откуда взялись текст и картинка.
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
        result.captionError
          ? `⚠️ LLM не ответил: <code>${escapeHtml(String(result.captionError).slice(0, 200))}</code>`
          : null,
        result.error ? `\n<code>${escapeHtml(String(result.error).slice(0, 300))}</code>` : null,
      ].filter(Boolean).join("\n");

      const finalText = (result.status === "ok" ? "✅ " : "⚠️ ") + report;

      // Редактируем то же сообщение. Если не вышло (например, его удалили) —
      // отправляем новое, чтобы отчёт не потерялся.
      if (statusId) {
        const edited = await editMessage(chatId, statusId, finalText, env);
        if (!edited?.ok) await sendMessage(chatId, finalText, env);
      } else {
        await sendMessage(chatId, finalText, env);
      }
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

    case "add_prompt_weekday":
      return addPrompt("weekday", text, chatId, env);

    case "add_prompt_weekend":
      return addPrompt("weekend", text, chatId, env);


    case "set_character": {
      await patchSettings(
        chatId,
        { character: text.slice(0, 2000), aiCaptions: true },
        env
      );
      await sendMessage(
        chatId,
        `✅ Характер чата сохранён (${Math.min(text.length, 2000)} симв.).` +
          (text.length > 2000 ? "\n⚠️ Текст обрезан до 2000 символов." : "") +
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


// Проверяет всё, что нужно для работы, и показывает что именно сломано.
async function runDiagnostics(chatId, env) {
  const s = await getSettings(chatId, env);
  const lines = ["🩺 <b>Диагностика этого чата</b>", ""];

  // --- секреты ---
  lines.push("<b>Ключи</b>");
  lines.push(`${env.BOT_TOKEN ? "✅" : "❌"} BOT_TOKEN`);
  lines.push(`${env.GOOGLE_API_KEY ? "✅" : "❌"} GOOGLE_API_KEY`);

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
  lines.push(`Модель текста: <code>${escapeHtml(getTextModel(env))}</code>`);

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
      lines.push(`✅ доступна, изображений: <b>${files.length}</b>`);
      if (!files.length) lines.push("⚠️ в папке нет картинок");
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
  lines.push(`источник: <b>${s.source}</b>`);

  await sendMessage(chatId, lines.join("\n"), env);
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
    await sendMessage(
      chatId,
      `❌ Не удалось прочитать папку.\n<code>${escapeHtml(String(e).slice(0, 300))}</code>\n\n` +
        "Проверьте: доступ «Все, у кого есть ссылка» и что ключ Google поддерживает Drive API.",
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
    "/settings — текущая конфигурация",
    "/set_source — источник картинок (кнопки)",
    "/set_gdrive — папка Google Drive",
    "/refresh_gdrive — обновить список файлов",
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
    "/ai_on, /ai_off — писать подписи нейросетью",
    "",
    "<b>Модели и расписание</b>",
    "/models — выбор модели (кнопки)",
    "/style — стиль картинок (кнопки)",
    "/set_timezone Europe/Moscow",
    "/set_weekday_time 09:00 или 09:00-09:40",
    "/set_weekend_time 10:30",
    "",
    "<b>Прочее</b>",
    "/voting_on, /voting_off",
    "/enable, /disable",
    "/test — отправить прямо сейчас",
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
      "/usage — остаток лимита Cloudflare",
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

  return [
    "⚙️ <b>Настройки этого чата</b>",
    `<i>chat_id: <code>${chatId}</code></i>`,
    "",
    `Рассылка: <b>${s.enabled ? "включена" : "выключена"}</b>`,
    `Источник: <b>${s.source}</b>`,
    `Google Drive: ${s.gdriveFolder ? "подключён ✅" : "не задан ❌"}`,
    `Модель NIM: <b>${s.nimModel}</b>`,
    `Стиль: <b>${getStyle(s.imageStyle).title}</b>`,
    "",
    `Промпты будней: <b>${wd || "—"}</b>`,
    `Промпты выходных: <b>${we || "—"}</b>`,
    wd || we ? "" : `Общий промпт: <i>${escapeHtml(String(s.nimPrompt).slice(0, 120))}</i>`,
    "",
    `Часовой пояс: <b>${s.timezone}</b>`,
    `Будни: <b>${s.weekdayTime}</b>`,
    `Выходные: <b>${s.weekendTime}</b>`,
    `Голосование: <b>${s.votingEnabled ? "да" : "нет"}</b>`,
    "",
    `Ваша роль: <b>${roleLabel(role)}</b>`,
    "",
    "<i>Настройки индивидуальны для каждого чата.</i>",
  ].filter((line) => line !== null).join("\n");
}
