# Fatakpay Daily Update Tracker

Website for the team to log daily work by department — same structure as the WhatsApp group updates.

## Live link (GitHub Pages)

After you push this repo and enable Pages, the site will be at:

`https://fatakpay-development.github.io/fatakpay-daily-update-tracker/`

## Shared updates (required)

GitHub Pages only hosts the website. To make **everyone see the same board**, connect a free Firebase Realtime Database:

1. Open [Firebase Console](https://console.firebase.google.com/) → Create project
2. **Build → Realtime Database → Create** → start in **test mode**
3. Project settings → Add web app → copy `firebaseConfig`
4. Copy `.env.example` to `.env` and paste the values there
5. Run `node scripts/generate-firebase-config.js` for local preview
6. Add the same keys as GitHub Actions secrets (never commit `.env` or `firebase-config.js`)

GitHub Actions builds `firebase-config.js` on deploy from those secrets. The live site still needs the config in the browser; it is just no longer stored in the repo.

Until Firebase is configured, the site shows a warning and will not accept shared submits.

## How to use

1. Open the live link
2. Select **Department** → **Your name**
3. Write tasks **one per line** → **Submit update**
4. Use **Copy for WhatsApp** to paste the day’s summary into the group
5. **Admin** (top-right) — enter the admin password only. It is checked on the server, not stored in the page.

## Local preview

Open `index.html` in a browser, or:

```bash
npx --yes serve .
```
