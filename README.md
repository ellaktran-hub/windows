# Home Window

A personal life-planner app: a retro pastel desktop of pop-up windows that reads the Notion "Life planner" live. It is phone-first and private.

## Status

Phase 1: the look, the five tabs, and sample content, which is clearly marked as sample. Nothing connects to Notion or Google yet. Taps change only what's on screen.

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
