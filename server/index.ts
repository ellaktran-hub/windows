// Small server that sits between the browser and Notion / Google.
// Phase 1: it serves sample content only. Later phases add the real
// readers here, so tokens stay on this side and never reach the browser.
//
// Safety rules kept in this file:
// - It listens on 127.0.0.1 only, so nothing else on the network can reach it yet.
// - There are no routes that delete, archive, pay, or mark a bill paid.

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { CalendarResponse, ListResponse } from "../shared/types.js";
import { sampleData } from "./sample.js";

const PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
// Lets me test empty, failed, and slow states in development with ?demo=empty|fail|slow.
const DEMO_MODES = !PROD || process.env.DEMO_MODES === "1";

const app = new Hono();

app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "https://fonts.googleapis.com"],
      fontSrc: ["https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
    referrerPolicy: "no-referrer",
  }),
);
app.use("/api/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

async function demo(c: Context): Promise<Response | "empty" | null> {
  if (!DEMO_MODES) return null;
  const mode = c.req.query("demo");
  if (mode === "slow") await new Promise((r) => setTimeout(r, 4000));
  if (mode === "fail") return c.json({ error: { code: "upstream_error", message: "Demo failure" } }, 502);
  if (mode === "empty") return "empty";
  return null;
}

function list<K extends "tasks" | "projects" | "bills" | "sleep">(key: K) {
  return async (c: Context) => {
    const d = await demo(c);
    if (d instanceof Response) return d;
    const items: unknown[] = d === "empty" ? [] : sampleData()[key];
    const body: ListResponse<unknown> = { source: "sample", items };
    return c.json(body);
  };
}

app.get("/api/health", (c) => c.json({ ok: true }));
app.get("/api/tasks", list("tasks"));
app.get("/api/projects", list("projects"));
app.get("/api/bills", list("bills"));
app.get("/api/sleep", list("sleep"));
app.get("/api/calendar", async (c) => {
  const d = await demo(c);
  if (d instanceof Response) return d;
  const body: CalendarResponse = { source: "sample", calendar: { connected: false } };
  return c.json(body);
});
app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "No such route" } }, 404));

if (PROD) {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("*", serveStatic({ path: "./dist/index.html" }));
}

app.onError((err, c) => {
  console.error("server error:", err.message);
  return c.json({ error: { code: "server_error", message: "Something went wrong on the server" } }, 500);
});

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`Home Window server on http://${HOST}:${info.port}${PROD ? "" : " (API only; open the Vite address)"}`);
});
