import { sendMessage, sendDocumentBytes, tg, escapeHtml } from "./telegram.js";
import { NIM_PROVIDERS, generateImage } from "./images/nim.js";
import { getPost } from "./db.js";
import { listChats, getSettings } from "./storage.js";

function sinceDate(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function padEnd(text, length) {
  const value = String(text ?? "");
  return value.length >= length
    ? value.slice(0, length - 1) + "…"
    : value + " ".repeat(length - value.length);
}

export async function handleStatsCommand(command, value, chatId, env) {
  const days = Number(value) > 0 ? Number(value) : 30;

  switch (command) {
    case "/stats":         return overview(chatId, days, env);
    case "/stats_models":  return byModel(chatId, days, env);
    case "/stats_chats":   return byChat(chatId, days, env);
    case "/stats_recent":  return recent(chatId, Number(value) || 10, env);
    case "/stats_post":    return postDetails(chatId, value.trim(), env);
    case "/stats_errors":  return errors(chatId, Number(value) || 10, env);
    case "/nim_health":    return health(chatId, env);
    case "/chats":         return chatsList(chatId, env);
    case "/export_csv":    return exportCsv(chatId, days, env);
  }
}

async function overview(chatId, days, env) {
  const from = sinceDate(days);

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok,
            SUM(CASE WHEN source='nim' THEN 1 ELSE 0 END) AS nim,
            SUM(CASE WHEN source='gdrive' THEN 1 ELSE 0 END) AS gdrive,
            COUNT(DISTINCT chat_id) AS chats,
            ROUND(AVG(latency_ms)) AS avg_latency
     FROM posts WHERE local_date >= ?`
  ).bind(from).first();

  const votes = await env.DB.prepare(
    `SELECT SUM(CASE WHEN v.vote=1  THEN 1 ELSE 0 END) AS likes,
            SUM(CASE WHEN v.vote=-1 THEN 1 ELSE 0 END) AS dislikes,
            COUNT(DISTINCT v.user_id) AS voters
     FROM votes v JOIN posts p ON p.id = v.post_id
     WHERE p.local_date >= ?`
  ).bind(from).first();

  return sendMessage(
    chatId,
    [
      `📊 <b>Сводка за ${days} дн.</b>`,
      "",
      `Постов: <b>${row.total || 0}</b> (успешно ${row.ok || 0})`,
      `Чатов: <b>${row.chats || 0}</b>`,
      `NIM: <b>${row.nim || 0}</b> · Google Drive: <b>${row.gdrive || 0}</b>`,
      `Средняя задержка: <b>${row.avg_latency || 0} мс</b>`,
      "",
      `👍 <b>${votes?.likes || 0}</b>   👎 <b>${votes?.dislikes || 0}</b>`,
      `Уникальных голосовавших: <b>${votes?.voters || 0}</b>`,
      "",
      "Подробнее: /stats_models, /stats_chats, /stats_recent",
    ].join("\n"),
    env
  );
}

async function byModel(chatId, days, env) {
  const from = sinceDate(days);

  // Голоса агрегируются ДО join, иначе COUNT(*) и AVG(latency)
  // множатся на число голосов у поста.
  const { results } = await env.DB.prepare(
    `SELECT p.provider, p.model, COUNT(*) AS posts,
            ROUND(AVG(p.latency_ms)) AS latency,
            COALESCE(SUM(v.likes),0)    AS likes,
            COALESCE(SUM(v.dislikes),0) AS dislikes
     FROM posts p
     LEFT JOIN (
       SELECT post_id,
              SUM(CASE WHEN vote=1  THEN 1 ELSE 0 END) AS likes,
              SUM(CASE WHEN vote=-1 THEN 1 ELSE 0 END) AS dislikes
       FROM votes GROUP BY post_id
     ) v ON v.post_id = p.id
     WHERE p.local_date >= ? AND p.provider IS NOT NULL
     GROUP BY p.provider ORDER BY likes DESC, posts DESC`
  ).bind(from).all();

  if (!results.length) return sendMessage(chatId, "Данных пока нет.", env);

  const header =
    padEnd("модель", 16) + padEnd("шт", 5) + padEnd("+", 5) +
    padEnd("-", 5) + padEnd("рейт", 7) + "мс";

  const lines = results.map((r) => {
    const total = r.likes + r.dislikes;
    const rating = total ? Math.round((r.likes / total) * 100) + "%" : "—";
    return padEnd(r.provider, 16) + padEnd(r.posts, 5) + padEnd(r.likes, 5) +
           padEnd(r.dislikes, 5) + padEnd(rating, 7) + (r.latency ?? "—");
  });

  const reliability = await env.DB.prepare(
    `SELECT provider, SUM(ok) AS success, COUNT(*) AS calls
     FROM gen_log WHERE created_at >= ?
     GROUP BY provider ORDER BY calls DESC`
  ).bind(new Date(Date.now() - days * 86400000).toISOString()).all();

  const relLines = reliability.results.map(
    (r) => padEnd(r.provider, 16) + padEnd(`${r.success}/${r.calls}`, 10) +
           `${Math.round((r.success / r.calls) * 100)}%`
  );

  return sendMessage(
    chatId,
    `🤖 <b>Рейтинг моделей за ${days} дн.</b>\n\n` +
      `<pre>${escapeHtml([header, ...lines].join("\n"))}</pre>\n` +
      `<b>Надёжность API</b>\n<pre>${escapeHtml(
        [padEnd("модель", 16) + padEnd("успех", 10) + "%", ...relLines].join("\n")
      )}</pre>`,
    env
  );
}

async function byChat(chatId, days, env) {
  const from = sinceDate(days);

  const { results } = await env.DB.prepare(
    `SELECT p.chat_id, p.chat_title, COUNT(*) AS posts,
            COALESCE(SUM(v.likes),0)    AS likes,
            COALESCE(SUM(v.dislikes),0) AS dislikes
     FROM posts p
     LEFT JOIN (
       SELECT post_id,
              SUM(CASE WHEN vote=1  THEN 1 ELSE 0 END) AS likes,
              SUM(CASE WHEN vote=-1 THEN 1 ELSE 0 END) AS dislikes
       FROM votes GROUP BY post_id
     ) v ON v.post_id = p.id
     WHERE p.local_date >= ? GROUP BY p.chat_id ORDER BY posts DESC`
  ).bind(from).all();

  if (!results.length) return sendMessage(chatId, "Данных нет.", env);

  const lines = results.map(
    (r) => `• <b>${escapeHtml(r.chat_title || r.chat_id)}</b>\n  постов ${r.posts} · 👍 ${r.likes} · 👎 ${r.dislikes}`
  );

  return sendMessage(chatId, `💬 <b>По чатам за ${days} дн.</b>\n\n${lines.join("\n")}`, env);
}

async function recent(chatId, limit, env) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.local_date, p.chat_title, p.provider, p.asset_name, p.status,
            COALESCE(SUM(CASE WHEN v.vote=1  THEN 1 ELSE 0 END),0) AS likes,
            COALESCE(SUM(CASE WHEN v.vote=-1 THEN 1 ELSE 0 END),0) AS dislikes
     FROM posts p LEFT JOIN votes v ON v.post_id = p.id
     GROUP BY p.id ORDER BY p.created_at DESC LIMIT ?`
  ).bind(Math.min(limit, 30)).all();

  if (!results.length) return sendMessage(chatId, "Постов ещё не было.", env);

  const lines = results.map((r) => {
    const icon = r.status === "ok" ? "✅" : "⚠️";
    const what = r.provider === "gdrive" ? `Drive: ${r.asset_name || "?"}` : r.provider || "—";
    return `${icon} <code>${r.id}</code> · ${r.local_date}\n   ${escapeHtml(r.chat_title || "")} · ${escapeHtml(what)}\n   👍 ${r.likes} 👎 ${r.dislikes}`;
  });

  return sendMessage(
    chatId,
    `🕒 <b>Последние посты</b>\n\n${lines.join("\n\n")}\n\nДетали: <code>/stats_post &lt;id&gt;</code>`,
    env
  );
}

async function postDetails(chatId, postId, env) {
  if (!postId) return sendMessage(chatId, "Использование: /stats_post &lt;id&gt;", env);

  const post = await getPost(env, postId);
  if (!post) return sendMessage(chatId, "Пост не найден.", env);

  const { results } = await env.DB.prepare(
    "SELECT username, vote FROM votes WHERE post_id = ? ORDER BY created_at DESC LIMIT 50"
  ).bind(postId).all();

  const likes = results.filter((v) => v.vote === 1).map((v) => "@" + (v.username || "?"));
  const dislikes = results.filter((v) => v.vote === -1).map((v) => "@" + (v.username || "?"));

  const caption = [
    `🔍 <b>Пост <code>${post.id}</code></b>`,
    "",
    `Чат: ${escapeHtml(post.chat_title || post.chat_id)}`,
    `Дата: ${post.local_date} (${post.is_weekend ? "выходной" : "будни"})`,
    `Источник: <b>${post.source}</b>`,
    `Провайдер: <b>${post.provider || "—"}</b>`,
    `Модель: ${escapeHtml(post.model || "—")}`,
    post.asset_name ? `Файл: ${escapeHtml(post.asset_name)}` : "",
    post.prompt ? `Промпт: <i>${escapeHtml(post.prompt.slice(0, 300))}</i>` : "",
    `Задержка: ${post.latency_ms || "—"} мс`,
    `Статус: <code>${post.status}</code>`,
    "",
    `👍 ${likes.length}: ${escapeHtml(likes.join(", ")) || "—"}`,
    `👎 ${dislikes.length}: ${escapeHtml(dislikes.join(", ")) || "—"}`,
  ].filter(Boolean).join("\n");

  if (post.tg_file_id) {
    return tg("sendPhoto", {
      chat_id: chatId, photo: post.tg_file_id, caption, parse_mode: "HTML",
    }, env);
  }

  return sendMessage(chatId, caption, env);
}

async function errors(chatId, limit, env) {
  const { results } = await env.DB.prepare(
    `SELECT created_at, provider, http_status, error
     FROM gen_log WHERE ok = 0 ORDER BY id DESC LIMIT ?`
  ).bind(Math.min(limit, 25)).all();

  if (!results.length) return sendMessage(chatId, "✅ Ошибок нет.", env);

  const lines = results.map(
    (r) => `• <b>${r.provider}</b> [${r.http_status || "net"}] ${r.created_at.slice(5, 16)}\n  <code>${escapeHtml((r.error || "").slice(0, 180))}</code>`
  );

  return sendMessage(chatId, `🐛 <b>Последние ошибки</b>\n\n${lines.join("\n\n")}`, env);
}

async function health(chatId, env) {
  await sendMessage(chatId, "🩺 Проверяю все модели NIM, это займёт до минуты…", env);

  const prompt = "a simple bright sunrise over hills, minimal, clean";
  const lines = [];

  for (const provider of NIM_PROVIDERS) {
    const started = Date.now();
    const result = await generateImage(prompt, env, {
      preferred: provider.id,
      noFallback: true,
    });
    const ok = result.ok && result.provider === provider.id;
    const attempt = result.attempts?.find((a) => a.provider === provider.id);

    lines.push(
      `${ok ? "✅" : "❌"} <b>${provider.id}</b> — ${Date.now() - started} мс` +
        (ok ? "" : `\n   <code>${escapeHtml((attempt?.error || "").slice(0, 150))}</code>`)
    );
  }

  return sendMessage(chatId, `🩺 <b>Состояние моделей</b>\n\n${lines.join("\n")}`, env);
}

async function chatsList(chatId, env) {
  const chats = await listChats(env);
  const lines = [];

  for (const id of chats) {
    const s = await getSettings(id, env);
    lines.push(
      `• ${escapeHtml(s.title || id)} <code>${id}</code>\n  ${s.enabled ? "🟢" : "🔴"} ${s.source} · ${s.weekdayTime}/${s.weekendTime} · ${s.timezone}`
    );
  }

  return sendMessage(chatId, `📋 <b>Чаты (${chats.length})</b>\n\n${lines.join("\n") || "пусто"}`, env);
}

async function exportCsv(chatId, days, env) {
  const from = sinceDate(days);

  const { results } = await env.DB.prepare(
    `SELECT p.id, p.local_date, p.chat_title, p.source, p.provider, p.model,
            p.asset_name, p.latency_ms, p.status,
            COALESCE(SUM(CASE WHEN v.vote=1 THEN 1 ELSE 0 END),0) AS likes,
            COALESCE(SUM(CASE WHEN v.vote=-1 THEN 1 ELSE 0 END),0) AS dislikes
     FROM posts p LEFT JOIN votes v ON v.post_id = p.id
     WHERE p.local_date >= ? GROUP BY p.id ORDER BY p.created_at DESC`
  ).bind(from).all();

  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

  const csv = [
    "id,date,chat,source,provider,model,asset,latency_ms,status,likes,dislikes",
    ...results.map((r) =>
      [r.id, r.local_date, r.chat_title, r.source, r.provider, r.model,
       r.asset_name, r.latency_ms, r.status, r.likes, r.dislikes].map(esc).join(",")
    ),
  ].join("\n");

  const bytes = new TextEncoder().encode("\uFEFF" + csv);

  return sendDocumentBytes(
    chatId, bytes, `stats-${from}.csv`,
    `📎 Экспорт за ${days} дн. — ${results.length} строк`, env
  );
}
