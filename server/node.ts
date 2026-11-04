// Runs Home Window on your own computer.
// It listens on this computer only (127.0.0.1), so nothing else on the
// network can reach it. The Cloudflare version is in worker.ts.

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.js";
import { NotionReader, NOTION_BASE } from "./notion.js";
import { googleConfigFrom } from "./google.js";

// Load .env if present (Node 20.12+). Values never get logged.
try { process.loadEnvFile(".env"); } catch { /* no .env yet */ }

const PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT || 8787);
const HOST = "127.0.0.1";
const TOKEN = (process.env.NOTION_TOKEN || "").trim();
// NOTION_API_BASE lets local tests point at a pretend Notion server.
const BASE = (!PROD && process.env.NOTION_API_BASE) || NOTION_BASE;
const reader = TOKEN ? new NotionReader(TOKEN, undefined, BASE) : null;

const app = createApp({
  notion: () => reader,
  demo: !PROD || process.env.DEMO_MODES === "1",
  extraOrigins: PROD ? [] : ["http://127.0.0.1:5173"],
  google: () => googleConfigFrom(process.env),
});

if (PROD) {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("*", serveStatic({ path: "./dist/index.html" }));
}

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`Home Window on http://${HOST}:${info.port}${PROD ? "" : " (API only; open the Vite address)"}`);
  console.log(reader ? "Notion: reading live data." : "Notion: no token in .env, so showing sample content.");
});
