// 🎰 Рулетка чата («кто сегодня … дня»).
//
// Команды:
//   /roulette          — крутить (один раз в день на чат)
//   /roulette_add      — участвовать самому; reply на сообщение + команда —
//                        добавить другого (админ чата или владелец бота)
//   /roulette_remove   — убрать себя; reply — убрать другого (админ/владелец)
//   /roulette_list     — участники
//   /roulette_top      — топ-10 за текущий год
//   /roulette_rules    — правила
//   /roulette_word     — сменить слово рулетки (ед. и мн. число), админы
//   /roulette_reset    — сбросить статистику текущего года, админы
//
// Всё состояние лежит в настройках чата (settings.roulette), как дни рождения:
//   {
//     wordSingular: "пов",          // форма для «1 пов»
//     wordPlural: "пов",            // форма для «5 пов» и «Топ-10 пов»
//     participants: { "<userId>": { name, username, addedBy, addedAt } },
//     wins: { "2026": { "<userId>": 3 } },
//     last: { date, userId, name, username, yearCount } | null,
//   }

import { sendMessage, editMessage, escapeHtml } from "./telegram.js";
import { getSettings, patchSettings } from "./storage.js";
import { setPending } from "./pending.js";
import { localParts } from "./scheduler.js";
import { canEdit, canGrant } from "./access.js";

export const ROULETTE_COMMANDS = new Set([
  "/roulette",
  "/roulette_add",
  "/roulette_join",
  "/roulette_remove",
  "/roulette_list",
  "/roulette_participants",
  "/roulette_top",
  "/roulette_stats",
  "/roulette_rules",
  "/roulette_word",
  "/roulette_reset",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function capitalize(text) {
  const value = String(text || "");
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

// Русская плюрализация: pluralizeRu(5, ["раз", "раза", "раз"]) -> "раз"
export function pluralizeRu(n, forms) {
  const abs = Math.abs(Number(n)) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

// Слово рулетки: форма для конкретного числа («1 пов», «5 повов»).
export function wordForCount(roulette, n) {
  return Number(n) === 1 ? roulette.wordSingular : roulette.wordPlural;
}

export function normalizeRoulette(settings) {
  const raw = settings?.roulette && typeof settings.roulette === "object"
    ? settings.roulette
    : {};
  return {
    wordSingular: String(raw.wordSingular || "пов").slice(0, 24),
    wordPlural: String(raw.wordPlural || raw.wordSingular || "пов").slice(0, 24),
    participants:
      raw.participants && typeof raw.participants === "object" ? raw.participants : {},
    wins: raw.wins && typeof raw.wins === "object" ? raw.wins : {},
    last: raw.last && typeof raw.last === "object" ? raw.last : null,
  };
}

async function saveRoulette(chatId, roulette, env) {
  await patchSettings(chatId, { roulette }, env);
  return roulette;
}

export function participantEntries(roulette) {
  return Object.entries(roulette.participants || {}).map(([id, p]) => ({
    id: String(id),
    name: p?.name || p?.username || String(id),
    username: p?.username || "",
  }));
}

export function displayName(person) {
  return person?.username || person?.name || String(person?.id || "");
}

export function mention(person) {
  if (person?.username) return "@" + escapeHtml(person.username);
  const name = escapeHtml(person?.name || String(person?.id || "участник"));
  return person?.id ? `<a href="tg://user?id=${person.id}">${name}</a>` : name;
}

export function rouletteKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🎰 Крутить", callback_data: "r|spin" },
        { text: "➕ Участвовать", callback_data: "r|join" },
      ],
      [
        { text: "🏆 Топ года", callback_data: "r|top" },
        { text: "👥 Участники", callback_data: "r|list" },
        { text: "📜 Правила", callback_data: "r|rules" },
      ],
      [
        { text: "🔤 Сменить слово", callback_data: "r|word" },
        { text: "🎰 Рулетка", callback_data: "r|home" },
      ],
    ],
  };
}

export function rouletteHomeText(settings) {
  const roulette = normalizeRoulette(settings);
  const count = participantEntries(roulette).length;
  const now = localParts(settings?.timezone || "Europe/Moscow");
  const todayWinner = roulette.last?.date === now.date ? roulette.last : null;

  return [
    "🎰 <b>Рулетка чата</b>",
    "",
    `Слово рулетки: <b>${escapeHtml(roulette.wordSingular)}</b> / <b>${escapeHtml(roulette.wordPlural)}</b>`,
    `Участников: <b>${count}</b>`,
    todayWinner
      ? `Сегодня уже выпал: <b>${escapeHtml(displayName(todayWinner))}</b>`
      : "Сегодня рулетку ещё не крутили.",
    "",
    "Крутить: <code>/roulette</code> (один раз в день)",
    "Участвовать: <code>/roulette_add</code>",
    "Топ: <code>/roulette_top</code> · Правила: <code>/roulette_rules</code>",
  ].join("\n");
}

export function rouletteRulesText(settings) {
  const roulette = normalizeRoulette(settings);
  const one = roulette.wordSingular;
  const many = roulette.wordPlural;

  return [
    "📜 <b>Правила рулетки</b>",
    "",
    `1. В рулетке участвуют только те, кто записался. Самому — <code>/roulette_add</code>.`,
    "2. Другого человека может добавить администратор чата или владелец бота: нужно <b>ответить на сообщение этого человека</b> командой <code>/roulette_add</code>. Себя каждый добавляет сам.",
    "3. Рулетка крутится командой <code>/roulette</code> — <b>один раз в день</b> на весь чат. Кто первый нажал, тот и разбудил машины.",
    `4. Бот случайно выбирает одного участника. Выпавший получает +1 в статистику: он теперь «${escapeHtml(one)} дня».`,
    `5. Статистика считается по годам. Лучшие видны в <code>/roulette_top</code> — «Топ-10 ${escapeHtml(many)} за текущий год».`,
    "6. Выйти из рулетки: <code>/roulette_remove</code>. Другого участника reply-командой может убрать админ или владелец.",
    `7. Слово рулетки (сейчас: «${escapeHtml(one)}» / «${escapeHtml(many)}») меняют админы командой <code>/roulette_word</code> — нужны формы для «1 …» и «5 …».`,
    "8. Решение рулетки окончательное и обжалованию не подлежит. Подкуп ведущего кофе учитывается, но на результат не влияет. ☕",
  ].join("\n");
}

export function rouletteListText(settings) {
  const roulette = normalizeRoulette(settings);
  const people = participantEntries(roulette)
    .sort((a, b) => displayName(a).localeCompare(displayName(b), "ru"));

  if (!people.length) {
    return [
      "👥 <b>Участники рулетки</b>",
      "",
      "Пока никого нет. Первый записавшийся автоматически становится легендой.",
      "",
      "Участвовать: <code>/roulette_add</code>",
    ].join("\n");
  }

  return [
    "👥 <b>Участники рулетки</b>",
    "",
    ...people.map((p, i) => `${i + 1}. ${escapeHtml(displayName(p))}`),
    "",
    `Всего участников — ${people.length}.`,
  ].join("\n");
}

export function rouletteTopText(settings, dateParts = null) {
  const roulette = normalizeRoulette(settings);
  const now = dateParts || localParts(settings?.timezone || "Europe/Moscow");
  const year = String(now.date || "").slice(0, 4) || String(new Date().getFullYear());
  const yearWins = roulette.wins?.[year] || {};
  const people = new Map(participantEntries(roulette).map((p) => [p.id, p]));

  const rows = Object.entries(yearWins)
    .map(([id, count]) => ({
      id: String(id),
      count: Number(count) || 0,
      name: people.get(String(id))?.username
        || people.get(String(id))?.name
        || (roulette.last?.userId === String(id) ? roulette.last.name : String(id)),
    }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ru"))
    .slice(0, 10);

  const total = participantEntries(roulette).length;

  if (!rows.length) {
    return [
      `🏆 <b>Топ-10 ${escapeHtml(roulette.wordPlural)} за текущий год</b>`,
      "",
      "Пока никто не выпадал. Рулетка ждёт первого героя.",
      "",
      `Всего участников — ${total}.`,
      "Крутить: <code>/roulette</code>",
    ].join("\n");
  }

  return [
    `🏆 <b>Топ-10 ${escapeHtml(roulette.wordPlural)} за текущий год</b>`,
    "",
    ...rows.map((row, i) =>
      `${i + 1}. ${escapeHtml(row.name)} — ${row.count} ${pluralizeRu(row.count, ["раз", "раза", "раз"])}`),
    "",
    `Всего участников — ${total}.`,
  ].join("\n");
}

// «пов повов», «пов\nповов», «пов;повов» -> { singular, plural }
export function parseRouletteWord(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  let parts = raw.split(/\n|;|\|/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1) parts = parts[0].split(/\s+/).filter(Boolean);
  if (!parts.length) return null;

  const clean = (s) => s.replace(/[<>"]/g, "").slice(0, 24);
  const singular = clean(parts[0]);
  if (!singular) return null;
  return { singular, plural: clean(parts[1] || parts[0]) || singular };
}

export async function applyRouletteWord(text, chatId, env) {
  const parsed = parseRouletteWord(text);
  if (!parsed) {
    await sendMessage(
      chatId,
      "❌ Не понял слово. Пришлите две формы, каждую с новой строки:\n<code>пов\nповов</code>",
      env
    );
    return;
  }

  const s = await getSettings(chatId, env);
  const roulette = normalizeRoulette(s);
  roulette.wordSingular = parsed.singular;
  roulette.wordPlural = parsed.plural;
  await saveRoulette(chatId, roulette, env);

  await sendMessage(
    chatId,
    `✅ Слово рулетки сохранено: <b>${escapeHtml(parsed.singular)}</b> / <b>${escapeHtml(parsed.plural)}</b>\n\n` +
      `Теперь будет: «1 ${escapeHtml(parsed.singular)}», «5 ${escapeHtml(parsed.plural)}» и «Топ-10 ${escapeHtml(parsed.plural)}».`,
    env
  );
}

function personFrom(user) {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
  return {
    name: name || user?.username || String(user?.id || ""),
    username: user?.username || "",
  };
}

async function addParticipant(chatId, targetUser, addedBy, env) {
  const s = await getSettings(chatId, env);
  const roulette = normalizeRoulette(s);
  const id = String(targetUser.id);
  const existed = Boolean(roulette.participants[id]);
  roulette.participants[id] = {
    ...personFrom(targetUser),
    addedBy: String(addedBy || ""),
    addedAt: new Date().toISOString(),
  };
  await saveRoulette(chatId, roulette, env);
  return { roulette, existed };
}

async function removeParticipant(chatId, targetId, env) {
  const s = await getSettings(chatId, env);
  const roulette = normalizeRoulette(s);
  const existed = Boolean(roulette.participants[String(targetId)]);
  delete roulette.participants[String(targetId)];
  await saveRoulette(chatId, roulette, env);
  return { roulette, existed };
}

// ── Сам розыгрыш ────────────────────────────────────────────────────────
const SPIN_INTROS = [
  "🎰 Эй, зачем разбудили...\n\n<i>Рулетка просыпается и недовольно смотрит на чат.</i>",
  "🎰 Барабан сам себя не покрутит.\n\n<i>Рулетка ворчит, но встаёт с дивана.</i>",
  "🎰 Так, кто опять нажал кнопку...\n\n<i>Рулетка делает вид, что ей неинтересно.</i>",
];
const SPIN_MIDDLES = [
  "🚓 Машины выехали.\n\n<i>Ведётся захват подозреваемого...</i>",
  "🚓 Выехали. Сирены для солидности включили.\n\n<i>Подозреваемый пока не в курсе.</i>",
  "🕵️ Сверяем приметы, алиби и кто сегодня подозрительно бодрый...",
];
const SPIN_FINALS = [
  "🔍 Подозреваемый вычислен. Сопротивление бесполезно.",
  "🔍 Всё сходится. Даже слишком хорошо сходится.",
  "📂 Досье закрыто. Имя названо, назад дороги нет.",
];

export async function spinRoulette(chatId, env, options = {}) {
  const settings = await getSettings(chatId, env);
  const roulette = normalizeRoulette(settings);
  const people = participantEntries(roulette);
  const now = localParts(settings.timezone || "Europe/Moscow");
  const year = String(now.date).slice(0, 4);

  if (!people.length) {
    await sendMessage(
      chatId,
      "🎰 <b>Рулетка пуста.</b>\n\nНекого выбирать: список участников пуст.\n\n" +
        "Записаться: <code>/roulette_add</code>\n" +
        "Админ или владелец может добавить человека ответом на его сообщение: reply + <code>/roulette_add</code>",
      env,
      { reply_markup: rouletteKeyboard() }
    );
    return { ok: false, reason: "empty" };
  }

  // Один розыгрыш в день на чат.
  if (roulette.last?.date === now.date && !options.force) {
    const winner = roulette.last;
    await sendMessage(
      chatId,
      `🎰 Рулетка на сегодня уже крутилась.\n\n` +
        `${capitalize(roulette.wordSingular)} дня: <b>${escapeHtml(displayName(winner))}</b> ` +
        `(${winner.yearCount || 1} ${pluralizeRu(winner.yearCount || 1, ["раз", "раза", "раз"])} за год).\n\n` +
        "Следующий захват подозреваемого — завтра.",
      env,
      { reply_markup: rouletteKeyboard() }
    );
    return { ok: false, reason: "already", winner };
  }

  // Защита от двойного одновременного запуска.
  const lockKey = `roulette:spin:${chatId}`;
  if (await env.BOT_KV.get(lockKey)) {
    await sendMessage(chatId, "🎰 Рулетка уже крутится. Машины в пути, подождите.", env);
    return { ok: false, reason: "locked" };
  }
  await env.BOT_KV.put(lockKey, "1", { expirationTtl: 120 });

  try {
    const winner = pick(people);
    const yearWins = { ...(roulette.wins[year] || {}) };
    yearWins[winner.id] = (Number(yearWins[winner.id]) || 0) + 1;
    roulette.wins = { ...roulette.wins, [year]: yearWins };
    roulette.last = {
      date: now.date,
      userId: winner.id,
      name: winner.name,
      username: winner.username,
      yearCount: yearWins[winner.id],
    };
    await saveRoulette(chatId, roulette, env);

    // Один редактируемый пост вместо спама: интрига в три акта.
    const sent = await sendMessage(chatId, pick(SPIN_INTROS), env);
    const messageId = sent?.result?.message_id;
    const show = async (text, markup) => {
      if (!messageId) return sendMessage(chatId, text, env, markup ? { reply_markup: markup } : {});
      const edited = await editMessage(chatId, messageId, text, env, markup).catch(() => null);
      if (!edited?.ok) return sendMessage(chatId, text, env, markup ? { reply_markup: markup } : {});
      return edited;
    };

    await sleep(900);
    await show(pick(SPIN_MIDDLES));
    await sleep(1100);
    await show(
      `${pick(SPIN_FINALS)}\n\n` +
        `🎉 <b>${escapeHtml(capitalize(roulette.wordSingular))} дня обыкновенный, 1 шт.</b> — ${mention(winner)}\n\n` +
        `В этом году это уже ${yearWins[winner.id]} ${pluralizeRu(yearWins[winner.id], ["раз", "раза", "раз"])}. ` +
        `Всего участников — ${people.length}.`,
      rouletteKeyboard()
    );

    return { ok: true, winner, count: yearWins[winner.id] };
  } finally {
    await env.BOT_KV.delete(lockKey).catch(() => null);
  }
}

// ── Команды ─────────────────────────────────────────────────────────────
export async function handleRouletteCommand(command, value, message, chatId, userId, role, env) {
  const settings = await getSettings(chatId, env);
  const roulette = normalizeRoulette(settings);

  if (command === "/roulette") {
    await spinRoulette(chatId, env);
    return;
  }

  if (command === "/roulette_rules") {
    await sendMessage(chatId, rouletteRulesText(settings), env, { reply_markup: rouletteKeyboard() });
    return;
  }

  if (command === "/roulette_list" || command === "/roulette_participants") {
    await sendMessage(chatId, rouletteListText(settings), env, { reply_markup: rouletteKeyboard() });
    return;
  }

  if (command === "/roulette_top" || command === "/roulette_stats") {
    await sendMessage(chatId, rouletteTopText(settings), env, { reply_markup: rouletteKeyboard() });
    return;
  }

  if (command === "/roulette_add" || command === "/roulette_join") {
    if (!userId) return;
    const target = message.reply_to_message?.from || message.from;
    if (!target?.id) return;
    const isSelf = String(target.id) === String(userId);

    if (!isSelf && !canGrant(role)) {
      await sendMessage(
        chatId,
        "⛔ Другого человека в рулетку может добавить только администратор чата или владелец бота — ответом на сообщение этого человека.\n\nСебя — просто <code>/roulette_add</code> без ответа на чужое сообщение.",
        env
      );
      return;
    }
    if (target.is_bot) {
      await sendMessage(chatId, "Ботов в рулетку не берём: они и так всё знают наперёд.", env);
      return;
    }

    const { existed } = await addParticipant(chatId, target, userId, env);
    const person = { id: String(target.id), ...personFrom(target) };
    await sendMessage(
      chatId,
      existed
        ? `🎰 ${mention(person)} уже участвует в рулетке. Второй раз записываться не надо — шанс от этого не вырастет.`
        : `✅ ${mention(person)} теперь участвует в рулетке.\n\nКрутить: <code>/roulette</code> · Участники: <code>/roulette_list</code>`,
      env
    );
    return;
  }

  if (command === "/roulette_remove") {
    if (!userId) return;
    const target = message.reply_to_message?.from || message.from;
    if (!target?.id) return;
    const isSelf = String(target.id) === String(userId);

    if (!isSelf && !canGrant(role)) {
      await sendMessage(
        chatId,
        "⛔ Убрать другого участника может только администратор чата или владелец бота — ответом на его сообщение.",
        env
      );
      return;
    }

    const { existed } = await removeParticipant(chatId, target.id, env);
    const person = { id: String(target.id), ...personFrom(target) };
    await sendMessage(
      chatId,
      existed
        ? `🗑 ${mention(person)} убран из рулетки. Статистика прошлых побед сохранена.`
        : `${mention(person)} и так не участвовал в рулетке.`,
      env
    );
    return;
  }

  if (command === "/roulette_word") {
    if (!canEdit(role)) {
      await sendMessage(chatId, "⛔ Слово рулетки может менять администратор чата или участник с выданным доступом.", env);
      return;
    }
    if (value) {
      await applyRouletteWord(value, chatId, env);
      return;
    }
    if (userId) await setPending(chatId, userId, "roulette_word", env);
    await sendMessage(
      chatId,
      "🔤 <b>Слово рулетки</b>\n\n" +
        "Пришлите слово в двух формах, каждую с новой строки:\n" +
        "1 — для «1 …» (единственное число)\n" +
        "2 — для «5 …» и «Топ-10 …» (множественное число)\n\n" +
        "<code>пов\nповов</code>\n\n" +
        `Сейчас: <b>${escapeHtml(roulette.wordSingular)}</b> / <b>${escapeHtml(roulette.wordPlural)}</b>\n\n` +
        "<b>Ответьте именно на это сообщение.</b>\n<i>/cancel — отмена</i>",
      env,
      { reply_markup: { force_reply: true, selective: true, input_field_placeholder: "пов / повов" } }
    );
    return;
  }

  if (command === "/roulette_reset") {
    if (!canEdit(role)) {
      await sendMessage(chatId, "⛔ Сбрасывать статистику рулетки может администратор чата или участник с выданным доступом.", env);
      return;
    }
    const now = localParts(settings.timezone || "Europe/Moscow");
    const year = String(now.date).slice(0, 4);
    const next = normalizeRoulette(settings);
    next.wins = { ...next.wins, [year]: {} };
    if (next.last && String(next.last.date || "").startsWith(year)) next.last = null;
    await saveRoulette(chatId, next, env);
    await sendMessage(chatId, `🗑 Статистика рулетки за ${year} год сброшена. Участники и слово сохранены.`, env);
    return;
  }
}
