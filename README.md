# Mom & Dad's Camino Blog

A travel blog for walking the Camino de Santiago. Readers follow along with no
account needed; the authors get a dead-simple, phone-first writing area behind
one shared password.

- **Latest Posts** — newest-first feed with photos and a tap-to-enlarge lightbox
- **Map** — interactive Camino Francés route with a "they are here" marker and the trail of towns already walked
- **Metrics** — daily stats table with automatic cumulative totals, a miles/km toggle, and charts
- **About the Camino** — a friendly explainer for readers new to the pilgrimage
- **Follow Along** — one-field email signup; subscribers get an email for every new post, with an unsubscribe link
- **/write** — the private author area (post, edit, delete, update location, enter daily numbers)

Photos are compressed on the phone before upload (~4 MB → ~300 KB), uploads show
progress and retry automatically on flaky wifi, and the post form auto-saves a
draft on the device so nothing is ever lost.

## Personalize it

Edit `config.json` — site title, tagline, route, start date, and the homepage
welcome message all live there. Day numbers auto-fill based on `startDate`.
The route towns (for the map, dropdowns, and progress bar) are in `camino-data.js`.

## Deploy to Render

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, pick the repo. `render.yaml` creates the web
   service and the Postgres database automatically.
3. Set these environment variables when prompted (or later under
   *Service → Environment*):

   | Variable | What it is |
   |---|---|
   | `AUTHOR_PASSWORD` | The one password your parents type at `/write`. Pick something easy to remember, e.g. `peregrinos2026` |
   | `SITE_URL` | Your site's full URL, e.g. `https://camino-blog.onrender.com` (used for links in emails) |
   | `RESEND_API_KEY` | *(optional)* API key from [resend.com](https://resend.com) — enables email notifications |
   | `FROM_EMAIL` | *(optional)* Verified sender, e.g. `Camino Blog <hello@yourdomain.com>` |

   Without a `RESEND_API_KEY`, everything works except the notification emails
   (signups are still collected, so you can add the key later).

Photos are stored in Postgres, so they survive deploys and restarts with no
extra storage service. At ~300 KB per compressed photo, a couple hundred photos
fit comfortably in the smallest database plan.

## Run locally

```bash
createdb camino
npm install
npm start          # http://localhost:3000
```

Local defaults: database `postgres://localhost:5432/camino`, author password
`buen-camino-2026`.

## A note for the authors

Everything you do starts at **yoursite.com/write**:

1. Type the family password once — your phone stays logged in for 6 months.
2. Tap the big button for what you want: write a post, move the map pin, or
   enter today's numbers.
3. Writing auto-saves on your phone as you type. If the wifi dies mid-post,
   nothing is lost — come back later and your draft is right where you left it.

Buen Camino!
