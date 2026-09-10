export function newPostId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export async function savePost(env, post) {
  await env.DB.prepare(
    `INSERT INTO posts
     (id, chat_id, chat_title, message_id, created_at, local_date, is_weekend,
      source, provider, model, prompt, asset_ref, asset_name, tg_file_id,
      latency_ms, status, error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      post.id,
      post.chatId,
      post.chatTitle || null,
      post.messageId || null,
      new Date().toISOString(),
      post.localDate,
      post.isWeekend ? 1 : 0,
      post.source,
      post.provider || null,
      post.model || null,
      post.prompt || null,
      post.assetRef || null,
      post.assetName || null,
      post.tgFileId || null,
      post.latency || null,
      post.status,
      post.error ? String(post.error).slice(0, 500) : null
    )
    .run();
}

export async function logAttempts(env, chatId, attempts) {
  if (!attempts?.length) return;

  const now = new Date().toISOString();

  const statements = attempts.map((attempt) =>
    env.DB.prepare(
      `INSERT INTO gen_log (created_at, chat_id, provider, ok, http_status, latency_ms, error)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(
      now,
      chatId,
      attempt.provider,
      attempt.ok ? 1 : 0,
      attempt.status || null,
      attempt.latency || null,
      attempt.error ? String(attempt.error).slice(0, 300) : null
    )
  );

  await env.DB.batch(statements);
}

export async function getVote(env, postId, userId) {
  const row = await env.DB.prepare(
    "SELECT vote FROM votes WHERE post_id = ? AND user_id = ?"
  ).bind(postId, String(userId)).first();

  return row?.vote ?? 0;
}

export async function setVote(env, postId, userId, username, vote) {
  if (vote === 0) {
    await env.DB.prepare("DELETE FROM votes WHERE post_id = ? AND user_id = ?")
      .bind(postId, String(userId))
      .run();
    return;
  }

  await env.DB.prepare(
    `INSERT INTO votes (post_id, user_id, username, vote, created_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(post_id, user_id)
     DO UPDATE SET vote = excluded.vote,
                   username = excluded.username,
                   created_at = excluded.created_at`
  )
    .bind(postId, String(userId), username || null, vote, new Date().toISOString())
    .run();
}

export async function countVotes(env, postId) {
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN vote = 1  THEN 1 ELSE 0 END), 0) AS likes,
       COALESCE(SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END), 0) AS dislikes
     FROM votes WHERE post_id = ?`
  ).bind(postId).first();

  return { likes: row?.likes || 0, dislikes: row?.dislikes || 0 };
}

export function getPost(env, postId) {
  return env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(postId).first();
}


// Лайки/дизлайки по каждому провайдеру — для /models.
// Голоса агрегируются ДО join, иначе счётчики множатся на число голосов.
export async function countRecentSearchDislikes(env, chatId, query, days = 7) {
  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT p.id) AS cnt
     FROM posts p
     JOIN votes v ON v.post_id = p.id AND v.vote = -1
     WHERE p.chat_id = ?
       AND p.source = 'search'
       AND p.prompt = ?
       AND p.created_at >= datetime('now', ?)`
  ).bind(String(chatId), String(query), `-${Number(days) || 7} days`).first();

  return Number(row?.cnt || 0);
}

export async function votesByProvider(env, chatId = null) {
  const where = chatId ? "WHERE p.chat_id = ?" : "";
  const stmt = env.DB.prepare(
    `SELECT p.provider,
            COUNT(*) AS posts,
            COALESCE(SUM(v.likes),0)    AS likes,
            COALESCE(SUM(v.dislikes),0) AS dislikes
     FROM posts p
     LEFT JOIN (
       SELECT post_id,
              SUM(CASE WHEN vote=1  THEN 1 ELSE 0 END) AS likes,
              SUM(CASE WHEN vote=-1 THEN 1 ELSE 0 END) AS dislikes
       FROM votes GROUP BY post_id
     ) v ON v.post_id = p.id
     ${where}
     GROUP BY p.provider`
  );

  const { results } = await (chatId ? stmt.bind(chatId) : stmt).all();

  const map = {};
  for (const r of results || []) {
    if (r.provider) map[r.provider] = r;
  }

  // Статистика неудачных попыток: когда модель вернула ошибку/брак, а бот
  // автоматически пошёл к следующей модели. Группируем по chat_id+created_at,
  // потому что logAttempts пишет все попытки одной генерации одним timestamp.
  try {
    const failWhere = chatId ? "WHERE g.chat_id = ?" : "";
    const failStmt = env.DB.prepare(
      `SELECT g.provider,
              COUNT(*) AS apiFails,
              SUM(CASE WHEN EXISTS (
                SELECT 1 FROM gen_log h
                WHERE h.chat_id = g.chat_id
                  AND h.created_at = g.created_at
                  AND h.ok = 1
              ) THEN 1 ELSE 0 END) AS switchedFails
       FROM gen_log g
       ${failWhere}
       ${failWhere ? "AND" : "WHERE"} g.ok = 0
       GROUP BY g.provider`
    );
    const failRows = await (chatId ? failStmt.bind(chatId) : failStmt).all();
    for (const r of failRows.results || []) {
      if (!r.provider) continue;
      map[r.provider] = map[r.provider] || { provider: r.provider, posts: 0, likes: 0, dislikes: 0 };
      map[r.provider].apiFails = Number(r.apiFails || 0);
      map[r.provider].switchedFails = Number(r.switchedFails || 0);
    }
  } catch {
    // старые базы/локальная диагностика не должны ломать /models
  }

  return map;
}
