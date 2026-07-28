import { handleCommand } from "./commands.js";
import { handleCallback } from "./voting.js";
import { runScheduler } from "./scheduler.js";
import { registerChat, removeChat } from "./storage.js";
import { sendMessage } from "./telegram.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("OK");
    }

    if (url.pathname === `/webhook/${env.WEBHOOK_SECRET}` && request.method === "POST") {
      const update = await request.json().catch(() => null);
      if (update) ctx.waitUntil(route(update, env));
      return Response.json({ ok: true });
    }

    return new Response("Good Morning Bot", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduler(env));
  },
};

async function route(update, env) {
  try {
    if (update.callback_query) {
      return handleCallback(update.callback_query, env);
    }

    if (update.my_chat_member) {
      const status = update.my_chat_member.new_chat_member?.status;
      const chat = update.my_chat_member.chat;

      if (["member", "administrator"].includes(status)) {
        const isNew = await registerChat(String(chat.id), chat, env);
        if (isNew) {
          await sendMessage(
            String(chat.id),
            "🌅 Привет! Я буду присылать «Доброе утро» с картинкой.\n\nНастрой меня: /help",
            env
          );
        }
      }

      if (["left", "kicked"].includes(status)) {
        await removeChat(String(chat.id), env);
      }
      return;
    }

    const message = update.message || update.channel_post;
    if (!message) return;

    // ВАЖНО: пропускаем любой текст, а не только начинающийся с "/".
    // Иначе ответ на вопрос бота ("пришлите ссылку") молча терялся.
    if (typeof message.text === "string" && message.text.trim()) {
      // У channel_post нет поля from: помечаем такие апдейты явно,
      // иначе userId === undefined и все проверки прав молча падают в false.
      const isChannelPost = Boolean(update.channel_post && !update.message);
      return handleCommand(message, env, { isChannelPost });
    }
  } catch (error) {
    console.log("route error:", String(error));
  }
}
