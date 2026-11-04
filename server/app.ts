// The app's JSON routes, shared by the computer version (node.ts) and the
// Cloudflare version (worker.ts).
//
// Safety rules kept in this file:
// - There are no routes that delete, archive, pay, or mark a bill paid.
// - Errors are logged as short codes only, never tokens or row content.

import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { CalendarResponse, ListResponse } from "../shared/types.js";
import { NotionFail, type NotionReader } from "./notion.js";
import { sampleData } from "./sample.js";

export interface AppOptions<E extends object> {
  /** The Notion reader for this request, or null to show sample content. */
  notion: (c: Context<{ Bindings: E }>) => NotionReader | null;
  /** Allow ?demo=empty|fail|slow for testing. Never on Cloudflare. */
  demo: boolean;
}

type Key = "tasks" | "projects" | "bills" | "sleep";

export const CSP = {
  defaultSrc: ["'self'"],
  styleSrc: ["'self'", "https://fonts.googleapis.com"],
  fontSrc: ["https://fonts.gstatic.com"],
  imgSrc: ["'self'", "data:"],
  connectSrc: ["'self'"],
  frameAncestors: ["'none'"],
  formAction: ["'self'"],
  baseUri: ["'self'"],
};

export function createApp<E extends object>(opts: AppOptions<E>) {
  const app = new Hono<{ Bindings: E }>();

  app.use("*", secureHeaders({ contentSecurityPolicy: CSP, referrerPolicy: "no-referrer" }));
  app.use("/api/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  async function demo(c: Context): Promise<Response | "empty" | null> {
    if (!opts.demo) return null;
    const mode = c.req.query("demo");
    if (mode === "slow") await new Promise((r) => setTimeout(r, 4000));
    if (mode === "fail") return c.json({ error: { code: "upstream_error", message: "Demo failure" } }, 502);
    if (mode === "empty") return "empty";
    return null;
  }

  const list = (key: Key) => async (c: Context<{ Bindings: E }>) => {
    const notion = opts.notion(c);
    const d = await demo(c);
    if (d instanceof Response) return d;
    if (d === "empty") return c.json({ source: notion ? "live" : "sample", items: [] } satisfies ListResponse<unknown>);
    if (!notion) return c.json({ source: "sample", items: sampleData()[key] as unknown[] } satisfies ListResponse<unknown>);
    try {
      const items: unknown[] = await notion[key]();
      return c.json({ source: "live", items } satisfies ListResponse<unknown>);
    } catch (e) {
      const code = e instanceof NotionFail ? e.code : "server_error";
      const status = e instanceof NotionFail ? e.status : 0;
      console.warn(`notion read ${key} failed: ${code}${status ? " (" + status + ")" : ""}`);
      const http = code === "unauthorized" ? 401 : code === "not_shared" ? 403 : code === "rate_limited" ? 429 : 502;
      return c.json({ error: { code, message: "Notion read failed" } }, http);
    }
  };

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/tasks", list("tasks"));
  app.get("/api/projects", list("projects"));
  app.get("/api/bills", list("bills"));
  app.get("/api/sleep", list("sleep"));
  app.get("/api/calendar", async (c) => {
    const d = await demo(c);
    if (d instanceof Response) return d;
    const body: CalendarResponse = { source: opts.notion(c) ? "live" : "sample", calendar: { connected: false } };
    return c.json(body);
  });
  app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "No such route" } }, 404));

  app.onError((err, c) => {
    console.error("server error:", err.name);
    return c.json({ error: { code: "server_error", message: "Something went wrong on the server" } }, 500);
  });

  return app;
}
