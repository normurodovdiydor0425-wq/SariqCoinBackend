# Sariq Coin Backend — Render

Render Web Service sifatida repozitoriy root katalogidan deploy qiling. Node.js 20 yoki yangiroq versiya kerak.

## Render sozlamalari

- **Root Directory:** bo‘sh qoldiring (repo root)
- **Build Command:** `npm install`
- **Start Command:** `npm start`

Render Environment’da quyidagilarni belgilang:

| Kalit | Qiymat |
|---|---|
| `NODE_ENV` | `production` |
| `DEMO_MODE` | `false` |
| `HOST` | `0.0.0.0` |
| `SESSION_SECRET` | Kamida 32 ta tasodifiy belgi |
| `FRONTEND_ORIGINS` | Aniq frontend HTTPS origin, masalan `https://loyiha.vercel.app` |
| `BOT_TOKEN` | BotFather tokeni, Render’da maxfiy qiymat sifatida |
| `ADMIN_TELEGRAM_ID` | Administratorning Telegram ID raqami |

`PORT` ni qo‘lda kiritmang; Render uni beradi. `FRONTEND_ORIGINS` ga yo‘l yoki oxirgi `/` qo‘shmang. Preview domenlaridan ham foydalanilsa, har bir aniq originni vergul bilan ajrating. `*` qo‘llamang.

## Saqlanadigan ma’lumot

Standart JSON baza va yuklangan videolar `data/` ichida saqlanadi. Render instance qayta yaratilganda bu katalog yo‘qolmasligi uchun `/var/data` ga Persistent Disk ulang va quyidagilarni belgilang:

- `DATA_FILE=/var/data/store.json`
- `VIDEO_MEDIA_DIR=/var/data/videos`

Persistent Disk ishlatilmasa, deploy yoki qayta ishga tushirishda ma’lumotlar yo‘qolishi mumkin. Hech qachon `.env`, `data/store.json` yoki `data/videos/` fayllarini GitHub’ga yubormang.

## Tekshirish

- Health check: `/healthz`
- Lokal testlar: `npm test`
- Brauzer CORS xatosi ko‘rsatsa, `FRONTEND_ORIGINS` Vercel domeniga aynan tengligini va Render’dagi deploy muvaffaqiyatli tugaganini tekshiring.
