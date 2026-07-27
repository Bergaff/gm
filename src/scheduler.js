import { getSettings, listChats } from "./storage.js";
import { sendMorning } from "./commands.js";

export function localParts(timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });

  const map = {};
  for (const part of formatter.formatToParts(new Date())) {
    if (part.type !== "literal") map[part.type] = part.value;
  }

  return {
    date: `${map.year}-${map.month}-${map.day}`,
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    isWeekend: ["Sat", "Sun"].includes(map.weekday),
  };
}

export function parseTimeSpec(spec) {
  const single = /^([01]\d|2[0-3]):([0-5]\d)$/;
  const range = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

  if (single.test(spec)) {
    const [h, m] = spec.split(":").map(Number);
    return { from: h * 60 + m, to: h * 60 + m };
  }

  const match = String(spec).match(range);
  if (!match) return null;

  const from = Number(match[1]) * 60 + Number(match[2]);
  const to = Number(match[3]) * 60 + Number(match[4]);

  return to >= from ? { from, to } : null;
}

function hash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return Math.abs(value);
}

export function targetMinute(chatId, dateKey, spec) {
  const parsed = parseTimeSpec(spec);
  if (!parsed) return null;
  if (parsed.from === parsed.to) return parsed.from;

  const span = parsed.to - parsed.from + 1;
  return parsed.from + (hash(`${chatId}:${dateKey}`) % span);
}

export async function runScheduler(env) {
  const chats = await listChats(env);

  for (const chatId of chats) {
    try {
      const settings = await getSettings(chatId, env);
      if (!settings.enabled) continue;

      const now = localParts(settings.timezone);
      const spec = now.isWeekend ? settings.weekendTime : settings.weekdayTime;
      const target = targetMinute(chatId, now.date, spec);

      if (target === null) continue;
      if (now.hour * 60 + now.minute !== target) continue;

      const guardKey = `sent:${chatId}:${now.date}`;
      if (await env.BOT_KV.get(guardKey)) continue;

      await env.BOT_KV.put(guardKey, "1", { expirationTtl: 60 * 60 * 40 });

      await sendMorning(chatId, settings, env, { test: false });
    } catch (error) {
      console.log(`scheduler error chat=${chatId}:`, String(error));
    }
  }
}
