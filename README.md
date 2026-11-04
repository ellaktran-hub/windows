# Home Window

A personal life-planner app: a retro pastel desktop of pop-up windows that reads the Notion "Life planner" live. It is phone-first and private.

## Status

- Phase 1 (done): the look, the five tabs, and clearly marked sample content.
- Phase 2 (done): reads Notion live. Without a token, it shows sample content.
- Phase 3 (done): taps save to Notion. That covers marking a task done (and undo, which restores its earlier status), Top 3, adding a task, and logging sleep. Each save is sent once and never retried on its own. If the result is unknown, the page says "Notion did not confirm. Refresh to check before trying again."
- Phase 4 (done): reads today's Google Calendar (read only) for work hours, payday and day-off tags, and appointments.
- Phase 5 (done): runs on Cloudflare behind an email login, and installs on your phone's home screen.

## Connect Notion (one time)

1. Go to https://www.notion.so/profile/integrations and choose "New integration".
2. Name it "Home Window", pick your workspace, and choose "Internal".
3. Under Capabilities, turn on "Read content", "Update content", and "Insert content". Nothing else is needed. The app has no way to delete anything.
4. Copy the "Internal Integration Secret". It starts with `ntn_`.
5. In this folder, copy `.env.example` to a new file named `.env`. Paste the secret after `NOTION_TOKEN=`, with no spaces or quotes.
6. Share each of the four databases (Tasks, Projects, Bills, Sleep Log) with the integration. Open the database, tap the `...` menu at the top right, choose "Connections", and add "Home Window".
7. Restart the app (`Ctrl+C`, then `npm run dev` again). The terminal should say "Notion: reading live data."

If a window says a database is not shared, repeat step 6 for that database. If it says the token was not accepted, check step 5.

## Put it on your phone (Cloudflare)

The app runs on Cloudflare Workers. Cloudflare Access sits in front of it with an email-code login that only your email can pass. The app also checks that login itself. Until steps 3 to 5 are done, it shows only a "locked" page, with no data.

Before signing up, check https://www.cloudflare.com/plans/developer-platform/ and the Zero Trust plans page. If any step asks for a card or a payment, stop there and decide first.

1. **Make a Cloudflare account** at https://dash.cloudflare.com/sign-up.
2. **Let GitHub deploy it.** This repo has a GitHub Action (`.github/workflows/deploy.yml`) that tests, builds, and deploys on every push to `main`. It needs two secrets in GitHub, under Settings, then Secrets and variables, then Actions:
   - `CLOUDFLARE_API_TOKEN`: in Cloudflare, go to My Profile, then API Tokens, then Create Token, and use the "Edit Cloudflare Workers" template.
   - `CLOUDFLARE_ACCOUNT_ID`: shown on the Cloudflare dashboard home or the Workers & Pages page, as "Account ID".

   Then, on GitHub, open Actions, choose "Deploy to Cloudflare", and tap "Run workflow". When it finishes, the worker's address ends in `.workers.dev`. Opening it should show "This page is locked." That is expected.
3. **Turn on the login.** Open the worker, go to Settings, then Domains & Routes. Next to the `workers.dev` address, turn on Cloudflare Access. Then open "Manage Cloudflare Access" and set the policy to allow only your email. If it asks you to create a Zero Trust team, pick a team name and the Free plan. Note the team name, because your team domain is `<team name>.cloudflareaccess.com`.
4. **Copy the AUD tag.** In Zero Trust, go to Access, then Applications, and open the app for this worker. Copy the "Application Audience (AUD) Tag".
5. **Add the settings.** Back on the worker, go to Settings, then Variables and Secrets, and add:
   - `ACCESS_TEAM_DOMAIN` (text), for example `yourteam.cloudflareaccess.com`
   - `ACCESS_AUD` (text), the AUD tag from step 4
   - `ALLOWED_EMAIL` (text), your email
   - `NOTION_TOKEN` (choose Secret), your Notion integration secret

   Save and deploy.
6. **Open it on your phone.** Sign in with the email code.
   - On an iPhone in Safari: tap Share, then "Add to Home Screen".
   - On Android in Chrome: tap the menu, then "Add to Home screen" or "Install app".

Every push to `main` deploys a new version automatically, through the GitHub Action.

## Connect Google Calendar (one time, read only)

1. At https://console.cloud.google.com, make a project called "Home Window" and enable the Google Calendar API.
2. Open "Google Auth Platform" (or "OAuth consent screen") and tap Get started. Use app name "Home Window", your email for support and contact, and audience "External".
3. Under Audience, tap **Publish app** so it's "In production". This keeps the calendar connected; in "Testing", Google disconnects it every 7 days. Google will call the app unverified. That's fine for an app only you use.
4. Under Clients, create an OAuth client of type "Web application", with this authorized redirect URI:
   `https://home-window.ellaktran.workers.dev/api/google/callback`
   Copy the Client ID and Client secret.
5. In Cloudflare, under the worker's Variables and Secrets, add `GOOGLE_CLIENT_ID` (text) and `GOOGLE_CLIENT_SECRET` (secret), then deploy.
6. Open the app. In today.exe, tap **connect calendar** and approve. If Google warns that the app isn't verified, choose Advanced, then continue.
7. Copy the code it shows and add it in Cloudflare as a secret named `GOOGLE_REFRESH_TOKEN`, then deploy.

If today.exe ever says the calendar needs connecting again, repeat steps 6 and 7.

## Run it on your computer

You need Node.js 20.19 or newer.

```bash
npm install
```

```bash
npm run dev
```

Then open http://127.0.0.1:5173 in your browser.

To try the built version instead:

```bash
npm run build
```

```bash
npm start
```

Then open http://127.0.0.1:8787.

Both versions listen only on this computer (127.0.0.1). Nothing else on your network can reach them yet.

## Checks

```bash
npm run check
```

```bash
npm test
```

```bash
npm run audit:safety
```

`audit:safety` fails if the code gains a way to delete, archive, or pay anything (cards, checkout, payment plans), or if anything that looks like a secret ends up in the built page. The bills tab can add a bill and tick or untick Paid, with a second tap to confirm. That only changes the box in Notion and never sends money.

To see the error, empty, and slow states while developing, add `?demo=fail`, `?demo=empty`, or `?demo=slow` to the address, for example http://127.0.0.1:5173/?demo=fail.

## Secrets

Secrets go only in a `.env` file, which git ignores. Copy `.env.example` to `.env` when a later phase asks for a value. Never put a token in the code or in chat.

## Layout

- `server/app.ts`: the app's JSON routes, shared by both versions.
- `server/node.ts`: runs it on your computer (127.0.0.1 only).
- `server/worker.ts`: runs it on Cloudflare, behind the login check in `server/access.ts`.
- `server/notion.ts`: reads Notion. The token stays on the server.
- `src/`: the page (plain TypeScript and CSS, built with Vite).
- `src/rules.ts`: the planner rules (Top 3, due today, coming up, start with, sleep).
- `shared/`: date and sleep-time helpers, and the data shapes.
- `tests/`: tests for the rules and date helpers.
