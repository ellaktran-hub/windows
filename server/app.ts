// The app's JSON routes, shared by the computer version (node.ts) and the
// Cloudflare version (worker.ts).
//
// Safety rules kept in this file:
// - There are no routes that delete, archive, pay, or mark a bill paid.
// - The only writes: a task's Status or Top 3, a new task, a new sleep entry.
//   Each checks its input, and none of them retries on its own.
// - Errors are logged as short codes only, never tokens or row content.

import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { CalendarResponse, ListResponse } from "../shared/types.js";
import { NotionFail, TASK_STATUSES, TIME_BLOCKS, type NotionReader } from "./notion.js";
import { sampleData } from "./sample.js";

export interface AppOptions<E extends object> {
  /** The Notion reader for this request, or null to show sample content. */
  notion: (c: Context<{ Bindings: E }>) => NotionReader | null;
  /** Allow ?demo=empty|fail|slow for testing. Never on Cloudflare. */
  demo: boolean;
  /** Extra page addresses allowed to send changes (the local Vite page in development). */
  extraOrigins?: string[];
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

  /* ---------- writes ---------- */
  // Writes must come from this page: JSON only, and same origin when the browser says where it came from.
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const ct = c.req.header("content-type") || "";
      const origin = c.req.header("origin");
      if (!ct.includes("application/json")) return c.json({ error: { code: "blocked", message: "JSON only" } }, 415);
      const allowed = [new URL(c.req.url).origin, ...(opts.extraOrigins || [])];
      if (origin && !allowed.includes(origin)) return c.json({ error: { code: "blocked", message: "Wrong origin" } }, 403);
    }
    await next();
  });

  const writeFail = (c: Context, what: string, e: unknown) => {
    const code = e instanceof NotionFail ? e.code : "unconfirmed";
    const status = e instanceof NotionFail ? e.status : 0;
    console.warn(`notion write ${what} failed: ${code}${status ? " (" + status + ")" : ""}`);
    const http = code === "unconfirmed" ? 504 : code === "unauthorized" ? 401 : code === "not_shared" ? 403 : code === "rate_limited" ? 429 : 400;
    return c.json({ error: { code, message: "Notion write failed" } }, http);
  };
  const bad = (c: Context, why: string) => c.json({ error: { code: "invalid", message: why } }, 400);
  async function body(c: Context): Promise<Record<string, unknown> | null> {
    try { const b = await c.req.json(); return b && typeof b === "object" && !Array.isArray(b) ? b : null; } catch { return null; }
  }
  const isDay = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
  const shortText = (v: unknown, max: number) => typeof v === "string" && v.trim().length <= max;

  async function writeDemo(c: Context): Promise<Response | "sample" | null> {
    const d = await demo(c);
    if (d instanceof Response) return c.json({ error: { code: "unconfirmed", message: "Demo" } }, 504);
    return null;
  }

  app.post("/api/tasks/:id/status", async (c) => {
    const b = await body(c);
    const status = b?.status;
    if (typeof status !== "string" || !(TASK_STATUSES as readonly string[]).includes(status)) return bad(c, "status");
    const dm = await writeDemo(c); if (dm instanceof Response) return dm;
    const notion = opts.notion(c);
    if (!notion) return c.json({ ok: true, source: "sample" });
    try { await notion.setTaskStatus(c.req.param("id"), status); return c.json({ ok: true, source: "live" }); }
    catch (e) { return writeFail(c, "status", e); }
  });

  app.post("/api/tasks/:id/top3", async (c) => {
    const b = await body(c);
    if (typeof b?.top3 !== "boolean") return bad(c, "top3");
    const dm = await writeDemo(c); if (dm instanceof Response) return dm;
    const notion = opts.notion(c);
    if (!notion) return c.json({ ok: true, source: "sample" });
    try { await notion.setTop3(c.req.param("id"), b.top3); return c.json({ ok: true, source: "live" }); }
    catch (e) { return writeFail(c, "top3", e); }
  });

  app.post("/api/tasks", async (c) => {
    const b = await body(c);
    const title = typeof b?.title === "string" ? b.title.trim() : "";
    const block = typeof b?.block === "string" ? b.block : "";
    const due = b?.due == null || b.due === "" ? null : b.due;
    if (!title || title.length > 200) return bad(c, "title");
    if (block && !(TIME_BLOCKS as readonly string[]).includes(block)) return bad(c, "block");
    if (due !== null && !isDay(due)) return bad(c, "due");
    const dm = await writeDemo(c); if (dm instanceof Response) return dm;
    const notion = opts.notion(c);
    if (!notion) return c.json({ ok: true, source: "sample" });
    try { await notion.createTask({ title, block, due: due as string | null }); return c.json({ ok: true, source: "live" }); }
    catch (e) { return writeFail(c, "new task", e); }
  });

  app.post("/api/sleep", async (c) => {
    const b = await body(c);
    const night = typeof b?.night === "string" ? b.night.trim() : "";
    const hours = b?.hours;
    if (!night || night.length > 20) return bad(c, "night");
    if (!shortText(b?.bed ?? "", 20) || !shortText(b?.wake ?? "", 20)) return bad(c, "times");
    if (typeof hours !== "number" || !isFinite(hours) || hours < 0 || hours > 24) return bad(c, "hours");
    const dm = await writeDemo(c); if (dm instanceof Response) return dm;
    const notion = opts.notion(c);
    if (!notion) return c.json({ ok: true, source: "sample" });
    try { await notion.createSleep({ night, bed: String(b?.bed ?? "").trim(), wake: String(b?.wake ?? "").trim(), hours }); return c.json({ ok: true, source: "live" }); }
    catch (e) { return writeFail(c, "sleep", e); }
  });

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
