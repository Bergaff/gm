import {
  DEFAULT_SETTINGS,
  WEEKDAY_MESSAGES,
  WEEKEND_MESSAGES,
  isAdmin,
} from "./config.js";
import { sendMessage, sendPhotoBytes, isChatAdmin, escapeHtml } from "./telegram.js";
import { getSettings, patchSettings, registerChat } from "./storage.js";
import { parseFolderId, getGdriveImage, listImages } from "./images/gdrive.js";
import { generateImage, NIM_PROVIDERS, getProvider } from "./images/nim.js";
import { newPostId, savePost, logAttempts } from "./db.js";
import { localParts, parseTimeSpec } from "./scheduler.js";
import { handleStatsCommand } from "./stats.js";

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
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
  const { test = false } = options;

  const now = localParts(settings.timezone);
  const text = pick(now.isWeekend ? WEEKEND_MESSAGES : WEEKDAY_MESSAGES);
  const caption = test ? `🧪 <i>Тестовая отправка</i>\n\n${text}` : text;

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
  if (useNim) {
    const result = await generateImage(settings.nimPrompt, env, {
      preferred: settings.nimModel,
      chatId,
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
      const result = await generateImage(settings.nimPrompt, env, {
        preferred: settings.nimModel,
        chatId,
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
    prompt: useNim ? settings.nimPrompt : null,
    assetRef: image?.assetRef || null,
    assetName: image?.assetName || null,
    tgFileId,
    latency: image?.latency || null,
    status,
    error,
  });

  return { postId, status, provider: image?.provider, error };
}

const KNOWN_COMMANDS = new Set([
  "/start", "/help", "/settings",
  "/set_source", "/set_gdrive", "/refresh_gdrive", "/set_prompt",
  "/models", "/set_model", "/set_timezone",
  "/set_weekday_time", "/set_weekend_time",
  "/voting_on", "/voting_off", "/enable", "/disable",
  "/test", "/reset",
  "/stats", "/stats_models", "/stats_chats", "/stats_recent",
  "/stats_post", "/stats_errors", "/nim_health", "/chats", "/export_csv",
]);

export async function handleCommand(message, env, options = {}) {
  const { isChannelPost = false } = options;

  const chatId = String(message.chat.id);
  const userId = message.from?.id;
  const text = (message.text || "").trim();

  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();
  const value = rest.join(" ").trim();

  // Регистрируем чат только на осмысленные команды, а не на любой текст с "/".
  // Иначе первый встречный в личке создаёт запись в KV и попадает в рассылку.
  if (KNOWN_COMMANDS.has(command)) {
    await registerChat(chatId, message.chat, env);
  } else {
    return;
  }

  if (
    command.startsWith("/stats") ||
    command === "/export_csv" ||
    command === "/nim_health" ||
    command === "/chats"
  ) {
    if (!isAdmin(userId)) {
      await sendMessage(chatId, "⛔ Эта команда доступна только владельцам бота.", env);
      return;
    }
    await handleStatsCommand(command, value, chatId, env);
    return;
  }

  if (command === "/start" || command === "/help") {
    await sendMessage(chatId, helpText(isAdmin(userId)), env);
    return;
  }

  if (command === "/settings") {
    const s = await getSettings(chatId, env);
    await sendMessage(chatId, settingsText(s), env);
    return;
  }

  const allowed = await isChatAdmin(chatId, userId, env);

    switch (command) {
      case "/set_source": {
        if (!["gdrive", "nim", "mixed"].includes(value)) {
          await sendMessage(chatId, "Использование: <code>/set_source gdrive|nim|mixed</code>", env);
          return;
        }
        await patchSettings(chatId, { source: value }, env);
        await sendMessage(chatId, `✅ Источник картинок: <b>${value}</b>`, env);
        return;
      }

    case "/set_gdrive": {
      const folderId = parseFolderId(value);
      if (!folderId) {
        await sendMessage(chatId, "Нужна ссылка вида <code>https://drive.google.com/drive/folders/...</code>", env);
        return;
      }
      try {
        const files = await listImages(folderId, env, true);
        await patchSettings(chatId, { gdriveFolder: value }, env);
        await sendMessage(chatId, `✅ Папка подключена.\nНайдено изображений: <b>${files.length}</b>`, env);
      } catch (e) {
        await sendMessage(
          chatId,
          `❌ Не удалось прочитать папку.\n<code>${escapeHtml(String(e).slice(0, 300))}</code>\n\nПроверь доступ «Все, у кого есть ссылка».`,
          env
        );
      }
      return;
    }

    case "/refresh_gdrive": {
      const s = await getSettings(chatId, env);
      const folderId = parseFolderId(s.gdriveFolder);
      if (!folderId) {
        await sendMessage(chatId, "Папка не настроена.", env);
        return;
      }
      const files = await listImages(folderId, env, true);
      await sendMessage(chatId, `♻️ Кэш обновлён. Изображений: <b>${files.length}</b>`, env);
      return;
    }

    case "/set_prompt": {
      if (value.length < 5) {
        await sendMessage(chatId, "Использование: <code>/set_prompt текст промпта</code>", env);
        return;
      }
      await patchSettings(chatId, { nimPrompt: value }, env);
      await sendMessage(chatId, "✅ Промпт сохранён.", env);
      return;
    }

    case "/models": {
      const lines = NIM_PROVIDERS.map((p, i) => `${i + 1}. <code>${p.id}</code> — ${p.title}`);
      await sendMessage(
        chatId,
        `🤖 <b>Модели NVIDIA NIM</b>\n\n${lines.join("\n")}\n\n<code>/set_model auto</code> — перебор всех с fallback`,
        env
      );
      return;
    }

    case "/set_model": {
      if (value !== "auto" && !getProvider(value)) {
        await sendMessage(chatId, "Неизвестная модель. Список: /models", env);
        return;
      }
      await patchSettings(chatId, { nimModel: value }, env);
      await sendMessage(chatId, `✅ Модель: <b>${value}</b>`, env);
      return;
    }

    case "/set_timezone": {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
      } catch {
        await sendMessage(chatId, "Пример: <code>/set_timezone Europe/Moscow</code>", env);
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
      if (!parseTimeSpec(value)) {
        await sendMessage(chatId, "Формат: <code>09:00</code> или диапазон <code>09:00-09:40</code>", env);
        return;
      }
      const field = command === "/set_weekday_time" ? "weekdayTime" : "weekendTime";
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
      await sendMessage(chatId, "⏳ Готовлю картинку…", env);
      const result = await sendMorning(chatId, s, env, { test: true });
      if (result.status !== "ok") {
        await sendMessage(
          chatId,
          `⚠️ Статус: <code>${result.status}</code>\n<code>${escapeHtml(String(result.error).slice(0, 400))}</code>`,
          env
        );
      }
      return;
    }

    case "/reset": {
      const s = await getSettings(chatId, env);
      await patchSettings(chatId, { ...DEFAULT_SETTINGS, title: s.title }, env);
      await sendMessage(chatId, "♻️ Настройки сброшены к значениям по умолчанию.", env);
      return;
    }
  }
}

function helpText(admin) {
  const base = [
    "🌅 <b>Good Morning Bot</b>",
    "",
    "<b>Настройки чата</b>",
    "/settings — текущая конфигурация",
    "/set_source gdrive|nim|mixed",
    "/set_gdrive &lt;ссылка&gt; — публичная папка Google Drive",
    "/refresh_gdrive — обновить список файлов",
    "/set_prompt &lt;текст&gt; — промпт для генерации",
    "/models — список моделей NVIDIA NIM",
    "/set_model auto|&lt;id&gt;",
    "/set_timezone Europe/Moscow",
    "/set_weekday_time 09:00 (или 09:00-09:40)",
    "/set_weekend_time 10:30",
    "/voting_on, /voting_off",
    "/enable, /disable",
    "/test — отправить прямо сейчас",
    "/reset — сброс настроек",
  ];

  if (admin) {
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
      "/chats",
      "/export_csv [дней]"
    );
  }

  return base.join("\n");
}

function settingsText(s) {
  return [
    "⚙️ <b>Настройки чата</b>",
    "",
    `Рассылка: <b>${s.enabled ? "включена" : "выключена"}</b>`,
    `Источник: <b>${s.source}</b>`,
    `Google Drive: ${s.gdriveFolder ? "подключён ✅" : "не задан ❌"}`,
    `Модель NIM: <b>${s.nimModel}</b>`,
    `Промпт: <i>${escapeHtml(s.nimPrompt.slice(0, 160))}</i>`,
    `Часовой пояс: <b>${s.timezone}</b>`,
    `Будни: <b>${s.weekdayTime}</b>`,
    `Выходные: <b>${s.weekendTime}</b>`,
    `Голосование: <b>${s.votingEnabled ? "да" : "нет"}</b>`,
  ].join("\n");
}
