import { answerCallback, editMarkup } from "./telegram.js";
import { getVote, setVote, countVotes } from "./db.js";
import { voteKeyboard } from "./commands.js";
import { getSettings } from "./storage.js";

export async function handleCallback(query, env) {
  const data = query.data || "";

  if (!data.startsWith("v|")) {
    await answerCallback(query.id, "", env);
    return;
  }

  const [, postId, rawVote] = data.split("|");
  const vote = Number(rawVote);
  const userId = query.from.id;

  // После /voting_off старые кнопки продолжали принимать голоса.
  const chatId = String(query.message?.chat?.id ?? "");
  const settings = await getSettings(chatId, env);
  if (!settings.votingEnabled) {
    await answerCallback(query.id, "Голосование выключено в этом чате", env, true);
    return;
  }

  const current = await getVote(env, postId, userId);
  const next = current === vote ? 0 : vote;

  await setVote(env, postId, userId, query.from.username || query.from.first_name, next);

  const counts = await countVotes(env, postId);

  await editMarkup(
    query.message.chat.id,
    query.message.message_id,
    voteKeyboard(postId, counts.likes, counts.dislikes),
    env
  );

  const toast = next === 0 ? "Голос отменён" : next === 1 ? "👍 Спасибо!" : "👎 Учтено";

  await answerCallback(query.id, toast, env);
}
