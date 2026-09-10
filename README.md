# 🌅 Good Morning Bot

Telegram-бот, который каждое утро присылает «Доброе утро» с картинкой.

## Возможности

- Картинки из публичной папки **Google Drive**, генерация через современные провайдеры (Cloudflare Workers AI / Gemini / NVIDIA NIM) или поиск картинок через **Google/Yandex Images** с safe-фильтром
- Разное время и разные тексты для **будней, выходных, выбранных праздников и дней рождения**; у праздников чата можно выбрать режим «будний» или «выходной»
- Отдельные настройки **для каждого чата**, включая характер и короткие характеристики AI-подписей
- Время можно задать **диапазоном** (`09:00-09:40`) — бот выберет случайную минуту
- Кнопки **👍 / 👎** под каждым постом
- **Статистика** по моделям, чатам и лайкам — доступна только Telegram ID из `ADMIN_IDS`
- Антиповторы для Drive и поиска; если один поисковый запрос несколько раз дизлайкают, бот предлагает сменить запрос через `/set_search`
- Кнопка отключения в `/menu`: бот остаётся в чате, но ничего не пишет по расписанию

## Стек

- Cloudflare Workers + Cron Triggers
- Cloudflare KV — настройки чатов
- Cloudflare D1 — посты, голоса, лог генераций

## Деплой

Push в `main` → Cloudflare Workers Builds → `npx wrangler deploy`.

## Секреты

Задаются в дашборде Cloudflare (Worker → Settings → Variables and Secrets):

- `BOT_TOKEN`
- `GOOGLE_API_KEY`
- `NVIDIA_API_KEY`
- `GEMINI_API_KEY` — опционально, Gemini только для более живых текстов; в генерации картинок Gemini не показывается и не используется
- `GEMINI_TEXT_MODEL` — опционально, первая Gemini-модель для текста; по умолчанию `gemini-3.5-flash`
- `GEMINI_TEXT_MODELS` — опционально, список Gemini-моделей для текста через запятую/пробел; бот пробует их по очереди, затем встроенный список `gemini-3.5-flash`, `gemini-3.1-flash-lite`, `gemini-2.5-flash-lite`, `gemini-2.5-flash`, `gemini-2.5-pro`
- `IMAGE_PINNED_FALLBACK=1` — разрешить старое поведение: если вручную выбранная модель картинок упала, пробовать остальные; по умолчанию ручной выбор строгий
- `TEST_TEXT_PROVIDER` — опционально, чем писать AI-подписи в `/test`; по умолчанию `cf`, Gemini в тестах не используется и остаётся только для утренних отправок
- `TEXT_API_KEY` / `NVIDIA_TEXT_API_KEY` — опционально для подписей и перевода промптов; для NVIDIA старый `meta/llama-3.3-70b-instruct` замените на `qwen/qwen3-next-80b-a3b-instruct`
- `PIXABAY_API_KEY` — опционально для источника `search` (бесплатные стоковые фото Pixabay)
- `PEXELS_API_KEY` — опционально для источника `search` (бесплатные стоковые фото Pexels)
- `SERPER_API_KEY` — опционально для источника `search` (Google Images через Serper, trial credits)
- `BRAVE_SEARCH_API_KEY` — опционально для источника `search` (Brave Images)
- `GOOGLE_SEARCH_CX` — опционально для источника `search` (старый Google Programmable Search Engine, если уже был включён full web)
- `GOOGLE_SEARCH_API_KEY` — опционально; если не задан, используется `GOOGLE_API_KEY`
- `IMAGE_SEARCH_PROVIDER` — `auto`, `yandex`, `duckduckgo`, `pixabay`, `pexels`, `serper`, `brave` или `google` (по умолчанию `auto`; для релевантности сначала Yandex/DuckDuckGo)
- `WEBHOOK_SECRET`
