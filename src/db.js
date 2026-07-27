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
