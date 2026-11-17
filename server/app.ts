// The app's JSON routes, shared by the computer version (node.ts) and the
// Cloudflare version (worker.ts).
//
// Safety rules kept in this file:
// - There are no routes that delete, archive, or pay anything.
// - The only writes: a task's Status or Top 3, a new task, a new sleep entry,
//   a new bill, a new or edited job application, and a bill's Paid box (the owner chose to allow this; the
//   page asks for a second tap first).
//   Each checks its input, and none of them retries on its own.
// - Errors are logged as short codes only, never tokens or row content.

import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { JOB_HOW, JOB_POSTED, JOB_PRIORITIES, JOB_SETUP, JOB_STATUSES } from "../shared/types.js";
import type { CalendarRangeResponse, CalendarResponse, ListResponse, ProjectContentResponse } from "../shared/types.js";
import { BILL_REPEATS, BILL_TYPES, cleanLink, type JobInput, NotionFail, TASK_STATUSES, TIME_BLOCKS, type NotionReader } from "./notion.js";
import { sampleCalendar, sampleData, sampleNotes } from "./sample.js";
import { authUrl, exchangeCode, GoogleFail, midnight, readRange, readToday, type GoogleConfig } from "./google.js";
import { addDays, todayStr } from "../shared/dates.js";

export interface AppOptions<E extends object> {
  /** The Notion reader for this request, or null to show sample content. */
  notion: (c: Context<{ Bindings: E }>) => NotionReader | null;
  /** Allow ?demo=empty|fail|slow for testing. Never on Cloudflare. */
  demo: boolean;
  /** Extra page addresses allowed to send changes (the local Vite page in development). */
  extraOrigins?: string[];
  /** Google Calendar settings for this request (any may be empty). */
  google: (c: Context<{ Bindings: E }>) => GoogleConfig;
}

type Key = "tasks" | "projects" | "bills" | "sleep" | "jobs";

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

  /** Checks a job application form. Returns the clean values, or a reason it was refused. */
  function jobInput(b: Record<string, unknown> | null): JobInput | string {
    const str = (k: string, max: number) => { const v = b?.[k]; return v == null ? "" : typeof v === "string" && v.trim().length <= max ? v.trim() : null; };
    const date = (k: string) => { const v = b?.[k]; return v == null || v === "" ? null : isDay(v) ? (v as string) : undefined; };
    const link = (k: string) => {
      const v = str(k, 500); if (v === null) return undefined; if (!v) return null;
      return cleanLink(v) ?? undefined;
    };
    const company = str("company", 120), role = str("role", 200), status = str("status", 40), next = str("next", 500),
      contactName = str("contactName", 200), notes = str("notes", 2000);
    const applied = date("applied"), followUp = date("followUp"), contactLink = link("contactLink"), postingLink = link("postingLink");
    const priority = str("priority", 20), posted = str("posted", 20), lastContacted = date("lastContacted");
    const howRaw = b?.how == null ? [] : b.how;
    const how = Array.isArray(howRaw) && howRaw.every((x) => typeof x === "string" && (JOB_HOW as readonly string[]).includes(x)) ? [...new Set(howRaw as string[])] : null;
    if (priority === null || (priority && !(JOB_PRIORITIES as readonly string[]).includes(priority))) return "priority";
    if (posted === null || (posted && !(JOB_POSTED as readonly string[]).includes(posted))) return "posted";
    if (how === null) return "how";
    if (lastContacted === undefined) return "date";
    const setup = str("setup", 20), location = str("location", 120);
    if (setup === null || (setup && !(JOB_SETUP as readonly string[]).includes(setup))) return "setup";
    if (location === null) return "text";
    const contactEmail = str("contactEmail", 200), contactPhone = str("contactPhone", 40), requirements = str("requirements", 2000);
    if (contactEmail === null || (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail))) return "email";
    if (contactPhone === null || (contactPhone && !/^[0-9+().\-\s x]{4,40}$/i.test(contactPhone))) return "phone";
    if (requirements === null) return "text";
    const postedPay = str("postedPay", 300), term = str("term", 80), startDate = date("startDate");
    if (postedPay === null || term === null) return "text";
    if (startDate === undefined) return "date";
    if (!company) return "company";
    if (role === null || next === null || contactName === null || notes === null) return "text";
    if (status === null || (status && !(JOB_STATUSES as readonly string[]).includes(status))) return "status";
    if (applied === undefined || followUp === undefined) return "date";
    if (contactLink === undefined || postingLink === undefined) return "link";
    return { company, role, status, applied, followUp, next, contactName, contactLink, postingLink, notes, priority, how, posted, lastContacted, setup, location, contactEmail, contactPhone, requirements, postedPay, term, startDate };
  }

  app.post("/api/jobs", async (c) => {
    const j = jobInput(await body(c));
    if (typeof j === "string") return bad(c, j);
    const dm = await writeDemo(c); if (dm instanceof Response) return dm;
    const notion = opts.notion(c);
    if (!notion) return c.json({ ok: true, source: "sample" });
    try { await notion.createJob(j); return c.json({ ok: true, source: "live" }); }
    catch (e) { return writeFail(c, "new job", e); }
  });

  app.post("/api/jobs/:id", async (c) => {
    const j = jobInput(await body(c));
    if (typeof j === "string") return bad(c, j);
    const dm = await writeDemo(c); if (dm instanceof Response) return dm;
    const notion = opts.notion(c);
    if (!notion) return c.json({ ok: true, source: "sample" });
    try { await notion.updateJob(c.req.param("id"), j); return c.json({ ok: true, source: "live" }); }
    catch (e) { return writeFail(c, "edit job", e); }
  });

  app.post("/api/bills/:id/paid", async (c) => {
    const b = await body(c);
    if (typeof b?.paid !== "boolean") return bad(c, "paid");
    const dm = await writeDemo(c); if (dm instanceof Response) return dm;
    const notion = opts.notion(c);
    if (!notion) return c.json({ ok: true, source: "sample" });
    try { await notion.setBillPaid(c.req.param("id"), b.paid); return c.json({ ok: true, source: "live" }); }
    catch (e) { return writeFail(c, "bill paid", e); }
  });

  app.post("/api/bills", async (c) => {
    const b = await body(c);
    const name = typeof b?.name === "string" ? b.name.trim() : "";
    const amount = b?.amount == null || b.amount === "" ? null : b.amount;
    const due = b?.due == null || b.due === "" ? null : b.due;
    const repeats = typeof b?.repeats === "string" ? b.repeats : "";
    const type = typeof b?.type === "string" ? b.type : "";
    if (!name || name.length > 120) return bad(c, "name");
    if (amount !== null && (typeof amount !== "number" || !isFinite(amount) || amount < 0 || amount > 1e7)) return bad(c, "amount");
    if (due !== null && !isDay(due)) return bad(c, "due");
    if (repeats && !(BILL_REPEATS as readonly string[]).includes(repeats)) return bad(c, "repeats");
    if (type && !(BILL_TYPES as readonly string[]).includes(type)) return bad(c, "type");
    const dm = await writeDemo(c); if (dm instanceof Response) return dm;
    const notion = opts.notion(c);
    if (!notion) return c.json({ ok: true, source: "sample" });
    try {
      await notion.createBill({ name, amount: amount === null ? null : Math.round((amount as number) * 100) / 100, due: due as string | null, repeats, type });
      return c.json({ ok: true, source: "live" });
    } catch (e) { return writeFail(c, "new bill", e); }
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

  // A project's notes, read only.
  app.get("/api/projects/:id/content", async (c) => {
    const d = await demo(c);
    if (d instanceof Response) return d;
    const notion = opts.notion(c);
    if (!notion) return c.json({ source: "sample", blocks: d === "empty" ? [] : sampleNotes(), truncated: false } satisfies ProjectContentResponse);
    try {
      const r = await notion.projectContent(c.req.param("id"));
      return c.json({ source: "live", ...r } satisfies ProjectContentResponse);
    } catch (e) {
      const code = e instanceof NotionFail ? e.code : "server_error";
      console.warn(`notion read project notes failed: ${code}`);
      const http = code === "unauthorized" ? 401 : code === "not_shared" || code === "not_found" ? 404 : code === "rate_limited" ? 429 : 502;
      return c.json({ error: { code, message: "Notion read failed" } }, http);
    }
  });

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/tasks", list("tasks"));
  // Tasks finished today, for done_today.txt.
  app.get("/api/tasks/done-today", async (c) => {
    const d = await demo(c);
    if (d instanceof Response) return d;
    const notion = opts.notion(c);
    if (!notion || d === "empty") return c.json({ source: notion ? "live" : "sample", items: [] } satisfies ListResponse<unknown>);
    try {
      return c.json({ source: "live", items: await notion.doneSince(midnight(todayStr())) } satisfies ListResponse<unknown>);
    } catch (e) {
      const code = e instanceof NotionFail ? e.code : "server_error";
      console.warn(`notion read done-today failed: ${code}`);
      return c.json({ error: { code, message: "Notion read failed" } }, 502);
    }
  });
  app.get("/api/projects", list("projects"));
  app.get("/api/bills", list("bills"));
  app.get("/api/sleep", list("sleep"));
  app.get("/api/jobs", list("jobs"));
  app.get("/api/calendar", async (c) => {
    const d = await demo(c);
    if (d instanceof Response) return d;
    const g = opts.google(c);
    const source = opts.notion(c) ? "live" : "sample";
    // Which day to show: today by default, or up to 13 days ahead.
    const today = todayStr();
    const day = c.req.query("day") || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < today || day > addDays(today, 13)) return c.json({ error: { code: "invalid", message: "day" } }, 400);
    if (!g.clientId || !g.clientSecret) {
      // With nothing real connected at all, show a marked sample calendar.
      if (source === "sample") return c.json({ source, calendar: sampleCalendar(day) } satisfies CalendarResponse);
      return c.json({ source, calendar: { connected: false } } satisfies CalendarResponse);
    }
    if (!g.refreshToken) return c.json({ source, calendar: { connected: false, canConnect: true } } satisfies CalendarResponse);
    try {
      const calendar = await readToday(g, day);
      return c.json({ source: "live", calendar } satisfies CalendarResponse);
    } catch (e) {
      const code = e instanceof GoogleFail ? e.code : "upstream_error";
      console.warn(`google read failed: ${code}${e instanceof GoogleFail && e.status ? " (" + e.status + ")" : ""}`);
      return c.json({ error: { code, message: "Calendar read failed" } }, code === "google_reconnect" ? 401 : code === "rate_limited" ? 429 : 502);
    }
  });

  // The calendar tab: up to 14 days starting today.
  app.get("/api/calendar/range", async (c) => {
    const d = await demo(c);
    if (d instanceof Response) return d;
    const today = todayStr();
    const days = Math.min(14, Math.max(1, Number(c.req.query("days") || 14) | 0));
    const g = opts.google(c);
    const source = opts.notion(c) ? "live" : "sample";
    const list: string[] = []; for (let i = 0; i < days; i++) list.push(addDays(today, i));
    if (!g.clientId || !g.clientSecret || !g.refreshToken) {
      if (source === "sample" && !g.clientId) return c.json({ source, connected: true, days: list.map((day) => ({ day, calendar: sampleCalendar(day) })) } satisfies CalendarRangeResponse);
      return c.json({ source, connected: false, canConnect: !!(g.clientId && g.clientSecret), days: [] } satisfies CalendarRangeResponse);
    }
    try {
      const byDay = await readRange(g, today, days);
      return c.json({ source: "live", connected: true, days: list.map((day) => ({ day, calendar: byDay[day] })) } satisfies CalendarRangeResponse);
    } catch (e) {
      const code = e instanceof GoogleFail ? e.code : "upstream_error";
      console.warn(`google range read failed: ${code}`);
      return c.json({ error: { code, message: "Calendar read failed" } }, code === "google_reconnect" ? 401 : code === "rate_limited" ? 429 : 502);
    }
  });

  /* ---------- one-time Google connect (read only) ---------- */
  const page = (title: string, body: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Home Window</title><link rel="stylesheet" href="/plain.css"></head><body><div class="w"><div class="b">${title}</div><div class="c">${body}</div></div><script src="/copy.js"></script></body></html>`;
  const callbackUrl = (c: Context) => new URL(c.req.url).origin + "/api/google/callback";

  app.get("/api/google/connect", (c) => {
    const g = opts.google(c);
    if (!g.clientId || !g.clientSecret) return c.html(page("calendar.txt", "<p>Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first. The steps are in the README.</p>"), 400);
    const state = crypto.randomUUID();
    const secure = new URL(c.req.url).protocol === "https:" ? "; Secure" : "";
    c.header("Set-Cookie", `hw_gstate=${state}; Path=/api/google; HttpOnly; SameSite=Lax; Max-Age=600${secure}`);
    return c.redirect(authUrl(g.clientId, callbackUrl(c), state), 302);
  });

  app.get("/api/google/callback", async (c) => {
    const g = opts.google(c);
    const cookie = (c.req.header("cookie") || "").split(/;\s*/).find((x) => x.startsWith("hw_gstate="))?.slice(10) || "";
    c.header("Set-Cookie", "hw_gstate=; Path=/api/google; HttpOnly; SameSite=Lax; Max-Age=0");
    if (c.req.query("error")) return c.html(page("calendar.txt", "<p>Google did not connect, so nothing changed. You can try again from the README steps.</p>"), 400);
    const code = c.req.query("code") || "";
    if (!code || !cookie || c.req.query("state") !== cookie) return c.html(page("calendar.txt", "<p>That link was out of date, so nothing changed. Please start the connect step again.</p>"), 400);
    try {
      const token = await exchangeCode(g, code, callbackUrl(c));
      return c.html(page("calendar_connected.txt",
        "<p><b>Almost done.</b> Copy this code and paste it into Cloudflare as a <b>Secret</b> named <code>GOOGLE_REFRESH_TOKEN</code>.</p>" +
        "<p>Paste it only into Cloudflare. Don't send it to anyone, including Claude.</p>" +
        `<textarea id="tok" readonly rows="4">${token.replace(/[<>&"]/g, "")}</textarea>` +
        '<p><button id="copy" type="button">copy</button> <span id="ok"></span></p>' +
        "<p>This page is not saved anywhere. Once it's pasted, you can close it.</p>"));
    } catch (e) {
      console.warn(`google connect failed: ${e instanceof GoogleFail ? e.code : "error"}`);
      return c.html(page("calendar.txt", "<p>Google did not finish connecting, so nothing changed. Please try the connect step again in a minute.</p>"), 400);
    }
  });

  app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "No such route" } }, 404));

  app.onError((err, c) => {
    console.error("server error:", err.name);
    return c.json({ error: { code: "server_error", message: "Something went wrong on the server" } }, 500);
  });

  return app;
}
