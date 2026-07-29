import { answerCallback, editMarkup, editMessage, sendMessage } from "./telegram.js";
import { getVote, setVote, countVotes, votesByProvider } from "./db.js";
import {
  voteKeyboard,
  sourceKeyboard,
  modelsKeyboard,
  modelsText,
  menuKeyboard,
  promptsKeyboard,
  promptsText,
  deletePrompt,
  editPrompt,
  settingsTextPublic,
} from "./commands.js";
import { getSettings, patchSettings } from "./storage.js";
import { getRole, canEdit } from "./access.js";
import { setPending } from "./pending.js";
import { NIM_PROVIDERS, getApiKeys, getAllProviders } from "./images/nim.js";
import { stylesKeyboard, stylesText, getStyle, STYLES } from "./styles.js";

export async function handleCallback(query, env) {
  const data = query.data || "";
  const chatId = String(query.message?.chat?.id ?? "");
  const userId = query.from.id;

  // ── Голосование ──────────────────────────────────────────────────────
  if (data.startsWith("v|")) {
    const settings = await getSettings(chatId, env);
    if (!settings.votingEnabled) {
      await answerCallback(query.id, "Голосование выключено в этом чате", env, true);
      return;
    }

    const [, postId, rawVote] = data.split("|");
    const vote = Number(rawVote);

    const current = await getVote(env, postId, userId);
    const next = current === vote ? 0 : vote;

    await setVote(env, postId, userId, query.from.username || query.from.first_name, next);

    const counts = await countVotes(env, postId);

    await editMarkup(
      chatId,
      query.message.message_id,
      voteKeyboard(postId, counts.likes, counts.dislikes),
      env
    );

    const toast = next === 0 ? "Голос отменён" : next === 1 ? "👍 Спасибо!" : "👎 Учтено";
    await answerCallback(query.id, toast, env);
    return;
  }


  // ── Навигация: кнопки «Назад» и переходы между разделами ────────────
  if (data.startsWith("nav|")) {
    const role = await getRole(chatId, userId, env);
    if (!canEdit(role)) {
      await answerCallback(query.id, "⛔ Доступно администратору чата", env, true);
      return;
    }

    const [, screen] = data.split("|");
    const s = await getSettings(chatId, env);
    const mid = query.message.message_id;

    if (screen === "menu") {
      await editMessage(chatId, mid, "📋 <b>Меню бота</b>\n\nВыберите раздел:", env, menuKeyboard());
    } else if (screen === "source") {
      await editMessage(chatId, mid, "🖼 <b>Источник картинок</b>", env, sourceKeyboard(s.source));
    } else if (screen === "style") {
      await editMessage(chatId, mid, stylesText(s.imageStyle, (t) => String(t)), env,
        stylesKeyboard(s.imageStyle));
    } else if (screen === "models") {
      let stats = {};
      try { stats = await votesByProvider(env, chatId); } catch { stats = {}; }
      await editMessage(
        chatId, mid,
        modelsText(getAllProviders(env), s.nimModel, stats, getApiKeys(env).length),
        env,
        modelsKeyboard(getAllProviders(env), s.nimModel, stats)
      );
    } else if (screen === "settings") {
      await editMessage(chatId, mid, settingsTextPublic(s, chatId, role), env, {
        inline_keyboard: [[{ text: "◀️ Назад в меню", callback_data: "nav|menu" }]],
      });
    } else if (screen === "diag") {
      await answerCallback(query.id, "Отправьте /diag — проверка занимает пару секунд", env, true);
      return;
    }

    await answerCallback(query.id, "", env);
    return;
  }


  // ── Дальше только настройки: нужны права ─────────────────────────────
  if (data.startsWith("s|") || data.startsWith("p|")) {
    const role = await getRole(chatId, userId, env);
    if (!canEdit(role)) {
      await answerCallback(query.id, "⛔ Менять настройки может админ чата", env, true);
      return;
    }

    // s|source|<value>  и  s|model|<value>
    if (data.startsWith("s|")) {
      const [, field, value] = data.split("|");

      if (field === "source") {
        await patchSettings(chatId, { source: value }, env);
        await editMarkup(chatId, query.message.message_id, sourceKeyboard(value), env);
        await answerCallback(query.id, `Источник: ${value}`, env);
        return;
      }

      if (field === "style") {
        if (!STYLES[value]) {
          await answerCallback(query.id, "Неизвестный стиль", env, true);
          return;
        }
        await patchSettings(chatId, { imageStyle: value }, env);
        await editMessage(
          chatId, query.message.message_id,
          stylesText(value, (t) => String(t)),
          env,
          stylesKeyboard(value)
        );
        await answerCallback(query.id, getStyle(value).title, env);
        return;
      }


      if (field === "model") {
        await patchSettings(chatId, { nimModel: value }, env);
        let stats = {};
        try { stats = await votesByProvider(env, chatId); } catch { stats = {}; }
        await editMessage(
          chatId, query.message.message_id,
          modelsText(getAllProviders(env), value, stats, getApiKeys(env).length),
          env,
          modelsKeyboard(getAllProviders(env), value, stats)
        );
        const idx = getAllProviders(env).findIndex((p) => p.id === value);
        await answerCallback(query.id, idx >= 0 ? `Модель ${idx + 1}` : "Авто", env);
        return;
      }
    }

    // p|add|<kind>  p|show|<kind>  p|dellist|<kind>  p|del|<kind>|<index>
    if (data.startsWith("p|")) {
      const [, action, kind, extra] = data.split("|");

      if (action === "add") {
        await setPending(chatId, userId, `add_prompt_${kind}`, env);
        await answerCallback(query.id, "Жду текст промпта", env);
        await sendMessage(
          chatId,
          `Пришлите текст промпта для <b>${kind === "weekend" ? "выходных" : "будней"}</b> следующим сообщением.\n\n<i>/cancel — отмена</i>`,
          env
        );
        return;
      }

      if (action === "show") {
        const s = await getSettings(chatId, env);
        const list = kind === "weekend" ? s.weekendPrompts : s.weekdayPrompts;
        await editMessage(
          chatId,
          query.message.message_id,
          promptsText(s, kind),
          env,
          promptsKeyboard(kind, (list || []).length)
        );
        await answerCallback(query.id, "", env);
        return;
      }


      // Список для выбора промпта на редактирование
      if (action === "editlist") {
        const s = await getSettings(chatId, env);
        const list = (kind === "weekend" ? s.weekendPrompts : s.weekdayPrompts) || [];

        if (!list.length) {
          await answerCallback(query.id, "Список пуст", env, true);
          return;
        }

        const rows = list.map((p, i) => [{
          text: `✏️ ${i + 1}. ${String(p).slice(0, 40)}`,
          callback_data: `p|edit|${kind}|${i}`,
        }]);
        rows.push([{ text: "◀️ Назад", callback_data: `p|show|${kind}` }]);

        await editMarkup(chatId, query.message.message_id, { inline_keyboard: rows }, env);
        await answerCallback(query.id, "Выберите, что изменить", env);
        return;
      }

      // Нажали конкретный промпт — ждём новый текст
      if (action === "edit") {
        const s = await getSettings(chatId, env);
        const list = (kind === "weekend" ? s.weekendPrompts : s.weekdayPrompts) || [];
        const idx = Number(extra);
        const cur = list[idx];

        if (!cur) {
          await answerCallback(query.id, "Промпт не найден", env, true);
          return;
        }

        await setPending(chatId, userId, `edit_prompt_${kind}_${idx}`, env);
        await answerCallback(query.id, "Жду новый текст", env);
        await sendMessage(
          chatId,
          `✏️ Текущий текст промпта <b>${idx + 1}</b>:\n<code>${cur}</code>\n\n` +
            "Пришлите новый текст следующим сообщением.\n\n<i>/cancel — отмена</i>",
          env
        );
        return;
      }

      if (action === "dellist") {
        const s = await getSettings(chatId, env);
        const list = (kind === "weekend" ? s.weekendPrompts : s.weekdayPrompts) || [];

        if (!list.length) {
          await answerCallback(query.id, "Список пуст", env, true);
          return;
        }

        const rows = list.map((p, i) => [{
          text: `🗑 ${i + 1}. ${String(p).slice(0, 40)}`,
          callback_data: `p|del|${kind}|${i}`,
        }]);
        rows.push([{ text: "◀️ Назад", callback_data: `p|show|${kind}` }]);

        await editMarkup(chatId, query.message.message_id, { inline_keyboard: rows }, env);
        await answerCallback(query.id, "Выберите, что удалить", env);
        return;
      }

      if (action === "del") {
        await deletePrompt(kind, Number(extra), chatId, env);
        await answerCallback(query.id, "Удалено", env);
        return;
      }
    }
  }

  await answerCallback(query.id, "", env);
}
