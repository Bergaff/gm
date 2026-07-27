# 🌅 Good Morning Bot

Telegram-бот, который каждое утро присылает «Доброе утро» с картинкой.

## Возможности

- Картинки из публичной папки **Google Drive** или генерация через **7 моделей NVIDIA NIM** с автоматическим fallback
- Разное время и разные тексты для **будней и выходных**
- Отдельные настройки **для каждого чата**
- Время можно задать **диапазоном** (`09:00-09:40`) — бот выберет случайную минуту
- Кнопки **👍 / 👎** под каждым постом
- **Статистика** по моделям, чатам и лайкам — доступна только Telegram ID из `ADMIN_IDS`

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
- `WEBHOOK_SECRET`
