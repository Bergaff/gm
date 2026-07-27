// ⚠️ Только эти Telegram ID видят статистику. Узнать свой: @userinfobot
export const ADMIN_IDS = [
  369330135,
  222222222,
];

export const DEFAULT_SETTINGS = {
  enabled: true,

  // gdrive | nim | mixed
  source: "gdrive",

  gdriveFolder: "",

  nimPrompt:
    "cozy good morning scene, soft sunrise light, coffee cup, warm cinematic atmosphere, highly detailed, photorealistic",

  // auto | конкретный id провайдера из nim.js
  nimModel: "auto",

  // вероятность взять NIM при source = mixed
  mixedNimChance: 0.5,

  timezone: "Europe/Moscow",

  // "09:00" или диапазон "09:00-09:40"
  weekdayTime: "09:00",
  weekendTime: "10:30",

  votingEnabled: true,

  // не повторять последние N картинок из Google Drive
  avoidRepeatLast: 15,
};

export const WEEKDAY_MESSAGES = [
  "☀️ Доброе утро! Пусть день будет продуктивным и лёгким.",
  "☕ С добрым утром! Кофе налит, дела ждут.",
  "🌤 Доброе утро! Сегодня отличный день, чтобы всё получилось.",
  "🚀 Новый день — новые возможности. Доброе утро!",
  "💪 Доброе утро! Начинаем день на позитиве.",
];

export const WEEKEND_MESSAGES = [
  "🌸 Доброе утро! Сегодня выходной — можно выдохнуть.",
  "🛌 С добрым утром! Отдыхай и восстанавливайся.",
  "🌈 Доброе утро! Пусть выходной будет спокойным и приятным.",
  "🍰 Доброе утро! Сегодня день для себя.",
  "🏖 Доброе утро! Планов нет — и это лучший план.",
];

export function isAdmin(userId) {
  return ADMIN_IDS.includes(Number(userId));
}
