// Готовые стили для генерации картинок.
//
// Проблема: пользователь пишет «кот на полу» и получает картинку уровня
// 2023 года. Хороший результат требует детального промпта с указанием
// освещения, композиции, качества — обычному человеку это писать незачем.
//
// Решение: он выбирает стиль кнопкой, бот дописывает нужные детали сам.

export const STYLES = {
  photo: {
    title: "📷 Фотореализм",
    hint: "как настоящая фотография",
    suffix:
      "professional photography, shot on Canon EOS R5, 85mm lens, f/1.8, " +
      "natural lighting, shallow depth of field, ultra realistic, " +
      "highly detailed, 8k, sharp focus",
    negative: "cartoon, anime, painting, illustration, 3d render, cgi",
  },

  cinematic: {
    title: "🎬 Кино",
    hint: "кадр из фильма, драматичный свет",
    suffix:
      "cinematic film still, dramatic lighting, volumetric light, " +
      "anamorphic lens flare, film grain, color graded, moody atmosphere, " +
      "shot on ARRI Alexa, highly detailed, 8k",
    negative: "flat lighting, amateur, low quality",
  },

  anime: {
    title: "🎌 Аниме",
    hint: "японская анимация",
    suffix:
      "anime style, high quality anime artwork, vibrant colors, " +
      "clean line art, detailed shading, studio-quality, " +
      "official art, pixiv trending, masterpiece",
    negative: "photorealistic, 3d render, western cartoon, blurry",
  },

  art: {
    title: "🎨 Живопись",
    hint: "картина маслом, галерейный вид",
    suffix:
      "oil painting, classical fine art, rich brush strokes, " +
      "museum masterpiece, dramatic chiaroscuro lighting, " +
      "warm color palette, canvas texture, highly detailed",
    negative: "photo, digital art, flat colors, low detail",
  },

  digital: {
    title: "💻 Цифровой арт",
    hint: "современная digital-иллюстрация",
    suffix:
      "digital art, concept art, trending on artstation, " +
      "highly detailed, dramatic lighting, vibrant colors, " +
      "professional illustration, 8k, sharp",
    negative: "photo, blurry, amateur, low resolution",
  },

  cozy: {
    title: "🕯 Уют",
    hint: "тёплая домашняя атмосфера",
    suffix:
      "cozy atmosphere, warm soft lighting, golden hour, " +
      "hygge aesthetic, soft focus background, inviting mood, " +
      "pastel tones, highly detailed, professional photography",
    negative: "dark, gloomy, harsh lighting, cold colors",
  },

  minimal: {
    title: "⬜ Минимализм",
    hint: "чисто, просто, много воздуха",
    suffix:
      "minimalist composition, clean background, negative space, " +
      "simple shapes, muted color palette, elegant, " +
      "studio lighting, high quality",
    negative: "cluttered, busy, chaotic, ornate",
  },

  none: {
    title: "🚫 Без стиля",
    hint: "промпт уходит как есть",
    suffix: "",
    negative: "",
  },
};

export const DEFAULT_STYLE = "photo";

export function getStyle(id) {
  return STYLES[id] || STYLES[DEFAULT_STYLE];
}

/**
 * Дописывает стиль к промпту пользователя.
 * «кот на полу» + photo -> «cat on the floor, professional photography,
 *  shot on Canon EOS R5, 85mm lens, ... 8k, sharp focus»
 */
export function applyStyle(prompt, styleId) {
  const style = getStyle(styleId);
  const base = String(prompt || "").trim();

  if (!base) return base;
  if (!style.suffix) return base;

  // Если пользователь уже написал развёрнутый промпт с техническими
  // деталями — не мешаем ему, стиль только помешает.
  if (looksDetailed(base)) return base;

  return `${base}, ${style.suffix}`;
}

// Промпт «уже подробный», если в нём есть характерные маркеры качества
// или он просто длинный.
export function looksDetailed(prompt) {
  const text = String(prompt || "").toLowerCase();
  const markers = [
    "8k", "4k", "highly detailed", "masterpiece", "photorealistic",
    "cinematic", "trending on", "shot on", "lens", "lighting",
    "ultra realistic", "artstation", "--ar", "--v ",
  ];
  const hits = markers.filter((m) => text.includes(m)).length;
  const words = text.split(/\s+/).filter(Boolean).length;

  return hits >= 2 || words > 35;
}

export function negativeFor(styleId) {
  return getStyle(styleId).negative || "";
}

// Клавиатура выбора стиля
export function stylesKeyboard(current) {
  const ids = Object.keys(STYLES);
  const rows = [];

  for (let i = 0; i < ids.length; i += 2) {
    const row = ids.slice(i, i + 2).map((id) => ({
      text: `${id === current ? "✅ " : ""}${STYLES[id].title}`,
      callback_data: `s|style|${id}`,
    }));
    rows.push(row);
  }

  rows.push([{ text: "◀️ Назад в меню", callback_data: "nav|menu" }]);
  return { inline_keyboard: rows };
}

export function stylesText(current, escapeHtml) {
  const lines = [
    "🎨 <b>Стиль картинок</b>",
    "",
    "Бот сам допишет к вашему промпту нужные детали —",
    "освещение, качество, композицию. Достаточно написать",
    "«кот на полу», остальное добавится автоматически.",
    "",
  ];

  for (const [id, s] of Object.entries(STYLES)) {
    const mark = id === current ? "✅ " : "";
    lines.push(`${mark}<b>${s.title}</b> — ${escapeHtml(s.hint)}`);
  }

  lines.push("");
  lines.push(
    "<i>Если вы пишете развёрнутый промпт сами (с указанием камеры, " +
      "света, «8k» и т.п.) — стиль не применяется, чтобы не мешать.</i>"
  );

  return lines.join("\n");
}
