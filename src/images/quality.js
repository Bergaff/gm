// Проверка, что модель вернула осмысленную картинку, а не сбой.
//
// Генераторы иногда отдают полностью чёрный (реже — однотонный) кадр:
// сработал safety-фильтр, свалился декодер, модель «не справилась».
// Формально ответ успешный, байты есть — и такой брак уходил в чат.

// Порог для PNG: размер отражает сложность картинки.
// Замеры: чёрная заливка 2.98, серая 5.09, одна полоска 5.11,
// градиент 5.46, минимализм 5.92. Серая заливка и валидная полоска
// практически неразличимы, поэтому берём 4 — ловим чёрный кадр
// и не трогаем простые, но валидные сцены.
const MIN_BYTES_PER_1000PX_PNG = 4;

// Для JPEG размер обманчив: минималистичная картинка весит столько же,
// сколько однотонная заливка. Зато энтропия сжатых данных различает их:
//   чёрная / серая заливка  ~2.01
//   тёмный портрет          ~4.43
//   минимализм              ~4.47
//   ночная сцена            ~6.20
//   детальная фотография    ~7.93
const MIN_SCAN_ENTROPY = 3.2;

const MIN_TOTAL_BYTES = 3000;

function jpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let i = 2;
  while (i < bytes.length - 9) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];

    const isSOF =
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isSOF) {
      return {
        width: (bytes[i + 7] << 8) | bytes[i + 8],
        height: (bytes[i + 5] << 8) | bytes[i + 6],
      };
    }

    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }

    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function pngSize(bytes) {
  if (bytes.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47];
  for (let i = 0; i < 4; i++) if (bytes[i] !== sig[i]) return null;

  return {
    width: (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19],
    height: (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23],
  };
}

export function imageFormat(bytes) {
  if (!bytes || bytes.length < 8) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "png";
  return null;
}

export function imageProblem(bytes) {
  if (!bytes || !bytes.length) return "пустой ответ";
  if (bytes.length < MIN_TOTAL_BYTES) {
    return `слишком маленький файл (${bytes.length} б)`;
  }

  const format = imageFormat(bytes);
  if (!format) return null;

  const size = format === "jpeg" ? jpegSize(bytes) : pngSize(bytes);
  if (!size || !size.width || !size.height) return null;

  const pixels = size.width * size.height;
  if (pixels < 1000) return "подозрительно малое разрешение";

  if (format === "png") {
    const density = (bytes.length / pixels) * 1000;
    if (density < MIN_BYTES_PER_1000PX_PNG) {
      return `однотонная картинка (${density.toFixed(1)} б/1000px)`;
    }
    return null;
  }

  const entropy = scanEntropy(bytes);
  if (entropy !== null && entropy < MIN_SCAN_ENTROPY) {
    return `однотонная картинка (энтропия ${entropy.toFixed(2)})`;
  }

  return null;
}

// Энтропия Шеннона по сжатым данным JPEG (всё после маркера SOS).
// Считаем по выборке: детальная картинка весит полмегабайта,
// полный проход тратил бы время впустую.
function scanEntropy(bytes) {
  let start = -1;
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xda) {
      start = i + 2;
      break;
    }
  }
  if (start < 0 || bytes.length - start < 512) return null;

  const counts = new Uint32Array(256);
  const total = bytes.length - start;
  const step = Math.max(1, Math.floor(total / 60000));

  let n = 0;
  for (let i = start; i < bytes.length; i += step) {
    counts[bytes[i]]++;
    n++;
  }
  if (n < 256) return null;

  let entropy = 0;
  for (let v = 0; v < 256; v++) {
    if (!counts[v]) continue;
    const p = counts[v] / n;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
