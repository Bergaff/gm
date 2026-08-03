// Общая библиотека примеров подписей.
//
// Задача: владелец один раз загружает документ с удачными примерами,
// и ВСЕ чаты пишут в этой манере — но не копируют, а генерируют своё,
// подстраиваясь под характер конкретного чата.
//
// Примеры лежат в KV одним общим ключом (не по чатам), потому что это
// эталон стиля для всего бота, а не настройка отдельной беседы.

const KEY = "examples:global";

// В промпт уходит несколько случайных примеров, но хранить стоит все:
// чем больше библиотека, тем разнообразнее подписи и тем реже
// повторяются одни и те же обороты.
// 150 штук по ~130 символов = около 20 КБ, при лимите значения KV 25 МБ.
const MAX_EXAMPLES = 150;
const MAX_LEN = 400;

/**
 * Разбирает загруженный текст на отдельные примеры.
 *
 * Поддерживаются оба формата:
 *   — примеры через пустую строку (если они многострочные);
 *   — по одному на строку.
 *
 * Строки-разделители («---», «===», «***») и нумерация в начале
 * («1.», «2)», «- ») отбрасываются: люди часто оформляют так списки.
 */
export function parseExamples(raw) {
  const text = String(raw || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return [];

  // Всегда режем по строкам, а затем склеиваем только те, что явно
  // продолжают друг друга. Иначе смешанный формат (часть примеров через
  // пустую строку, часть подряд) склеивал по два примера в один.
  const chunks = text.split("\n");

  const out = [];

  for (const chunk of chunks) {
    let line = chunk.trim();
    if (!line) continue;

    // строка-разделитель целиком
    if (/^[-=*_#\s]+$/.test(line)) continue;

    // «1. », «2) », «- », «• » в начале
    line = line.replace(/^\s*(?:\d+[.)]|[-•*])\s+/, "").trim();

    // кавычки вокруг примера
    line = line.replace(/^["«„'`]+|["»“'`]+$/g, "").trim();

    if (line.length < 10) continue;

    // Заголовок вроде «Примеры удачных подписей» — не пример.
    // Раньше проверяли по знаку препинания, но живая подпись вполне
    // может быть без точки: «Доброе утро, кому надо рано вставать».
    // Надёжнее смотреть на длину: заголовки короткие, подписи длиннее.
    const words = line.split(/\s+/).filter(Boolean).length;
    if (words < 4 && !/[.!?…]/.test(line)) continue;

    out.push(line.slice(0, MAX_LEN));

    if (out.length >= MAX_EXAMPLES) break;
  }

  return out;
}

export async function getExamples(env) {
  try {
    const data = await env.BOT_KV.get(KEY, "json");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function saveExamples(env, list) {
  const clean = (Array.isArray(list) ? list : []).slice(0, MAX_EXAMPLES);
  await env.BOT_KV.put(KEY, JSON.stringify(clean));
  return clean;
}

export async function clearExamples(env) {
  try {
    await env.BOT_KV.delete(KEY);
  } catch {
    // не критично
  }
}

/**
 * Берёт несколько случайных примеров для промпта.
 *
 * Случайных — важно: если всегда подсовывать первые три, модель
 * начнёт воспроизводить именно их, и подписи станут однообразными.
 */
export function pickExamples(list, count = 4) {
  const src = Array.isArray(list) ? [...list] : [];
  if (src.length <= count) return src;

  const out = [];
  for (let i = 0; i < count && src.length; i++) {
    const idx = Math.floor(Math.random() * src.length);
    out.push(src.splice(idx, 1)[0]);
  }
  return out;
}

// Текст для команды /examples
export function examplesText(list, escapeHtml) {
  const lines = ["📚 <b>Примеры подписей</b>", ""];

  if (!list.length) {
    lines.push("<i>Пока не загружены — подписи пишутся без образца.</i>");
    lines.push("");
    lines.push("Пришлите <b>.txt</b> файл с удачными примерами:");
    lines.push("по одному на строку либо через пустую строку.");
    lines.push("");
    lines.push("Примеры общие для всех чатов, но в каждом чате бот");
    lines.push("пишет своё — под характер именно той беседы.");
    return lines.join("\n");
  }

  lines.push(`Загружено: <b>${list.length}</b>`);
  lines.push("");
  lines.push("<i>Первые несколько:</i>");

  for (const ex of list.slice(0, 5)) {
    lines.push(`• ${escapeHtml(String(ex).slice(0, 120))}`);
  }

  if (list.length > 5) {
    lines.push(`<i>…и ещё ${list.length - 5}</i>`);
  }

  lines.push("");
  lines.push("Заменить — пришлите новый .txt файл.");
  lines.push("Удалить — /examples_clear");

  return lines.join("\n");
}
