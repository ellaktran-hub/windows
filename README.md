# Home Window

A personal life-planner app: a retro pastel desktop of pop-up windows that reads the Notion "Life planner" live. It is phone-first and private.

## Status

- Phase 1 (done): the look, the five tabs, and clearly marked sample content.
- Phase 2 (done): reads Notion live when a token is in `.env`. Without one, it shows sample content. Taps don't save anything yet. Saving comes in phase 3.

## Connect Notion (one time)

1. Go to https://www.notion.so/profile/integrations and choose "New integration".
2. Name it "Home Window", pick your workspace, and choose "Internal".
3. Under Capabilities, turn on "Read content" only for now. Phase 3 will ask you to add "Update content" and "Insert content".
4. Copy the "Internal Integration Secret". It starts with `ntn_`.
5. In this folder, copy `.env.example` to a new file named `.env`. Paste the secret after `NOTION_TOKEN=`, with no spaces or quotes.
6. Share each of the four databases (Tasks, Projects, Bills, Sleep Log) with the integration. Open the database, tap the `...` menu at the top right, choose "Connections", and add "Home Window".
7. Restart the app (`Ctrl+C`, then `npm run dev` again). The terminal should say "Notion: reading live data."

If a window says a database is not shared, repeat step 6 for that database. If it says the token was not accepted, check step 5.

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

`audit:safety` fails if the code gains a way to delete, archive, pay, or mark a bill paid, or if anything that looks like a secret ends up in the built page.

To see the error, empty, and slow states while developing, add `?demo=fail`, `?demo=empty`, or `?demo=slow` to the address, for example http://127.0.0.1:5173/?demo=fail.

## Secrets

Secrets go only in a `.env` file, which git ignores. Copy `.env.example` to `.env` when a later phase asks for a value. Never put a token in the code or in chat.

## Layout

- `server/`: the small Hono server. Later phases keep the Notion and Google credentials here.
- `src/`: the page (plain TypeScript and CSS, built with Vite).
- `src/rules.ts`: the planner rules (Top 3, due today, coming up, start with, sleep).
- `shared/`: date and sleep-time helpers, and the data shapes.
- `tests/`: tests for the rules and date helpers.
