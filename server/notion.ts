// Reads the Notion "Life planner" through Notion's REST API.
// Server side only: the token is passed in by the server entry and never
// sent to the browser or written to logs.
//
// Reads, plus a few small writes: task status, Top 3, new task, new sleep
// entry, new bill, and a bill's Paid box (which only ticks the box; it
// never pays anything). There is no delete, archive, or trash call here.

import type { Bill, NoteBlock, Project, RichBit, SleepEntry, Task } from "../shared/types.js";

export const NOTION_VERSION = "2026-03-11";
export const NOTION_BASE = "https://api.notion.com/v1";
const TIMEOUT_MS = 15000;
const MAX_PAGES = 5; // up to 500 rows per database, plenty for a personal planner

export const DS = {
  tasks: "389e8a58-d4c0-4dac-bb77-d8a7affb26ec",
  projects: "03280a77-83cc-40d1-9465-5340eff0797f",
  bills: "6ec82b3f-4d3d-4783-9b71-1c049e3cdb95",
  sleep: "d47b77d7-18a4-4b1d-9a9d-63b24a309376",
} as const;

/** A failure with a short code the page knows how to explain calmly. */
export class NotionFail extends Error {
  constructor(public code: string, public status: number, detail = "") {
    super(code + (detail ? ": " + detail : ""));
  }
}

type Fetch = typeof fetch;
export interface NotionPage { id: string; url: string; created_time: string; properties: Record<string, any> }

export function idOf(u: string): string {
  const m = String(u || "").replace(/-/g, "").match(/[0-9a-f]{32}/i);
  return m ? m[0].toLowerCase() : String(u || "");
}

export const TASK_STATUSES = ["Not started", "In progress", "Done"] as const;
export const TIME_BLOCKS = ["Morning", "Work day", "Lunch", "After work", "Evening"] as const;

export interface NewTask { title: string; block: string; due: string | null }
export const BILL_TYPES = ["Rent", "Utilities", "Other", "Yearly renewal"] as const;
export const BILL_REPEATS = ["Monthly", "Yearly", "One-time"] as const;
export interface NewBill { name: string; amount: number | null; due: string | null; repeats: string; type: string }
export interface NewSleep { night: string; bed: string; wake: string; hours: number }

export class NotionReader {
  // base can point at a pretend Notion server, for local tests only.
  constructor(private token: string, private fetchImpl: Fetch = (i, init) => fetch(i, init), private base: string = NOTION_BASE) {}

  /**
   * One request to Notion. Reads may try once more after a rate limit.
   * Writes never retry: if the result is unknown (timeout, network, or a
   * Notion server error) they fail with "unconfirmed" so the page can say so.
   */
  private async send(method: "GET" | "POST" | "PATCH", path: string, body: unknown, write: boolean, retried = false): Promise<any> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        method,
        headers: {
          Authorization: "Bearer " + this.token,
          "Notion-Version": NOTION_VERSION,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: ctl.signal,
      });
    } catch {
      if (write) throw new NotionFail("unconfirmed", 0);
      throw new NotionFail(ctl.signal.aborted ? "timeout" : "upstream_error", 0);
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      try { return await res.json(); } catch { if (write) throw new NotionFail("unconfirmed", res.status); throw new NotionFail("bad_shape", res.status); }
    }

    let code = "";
    try { code = ((await res.json()) as { code?: string }).code || ""; } catch { /* no body */ }
    if (res.status === 429 && !write && !retried) {
      const wait = Math.min(Number(res.headers.get("retry-after") || 1), 5) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return this.send(method, path, body, write, true);
    }
    if (res.status === 401) throw new NotionFail("unauthorized", 401, code);
    if (res.status === 403 || res.status === 404) throw new NotionFail("not_shared", res.status, code);
    if (res.status === 429) throw new NotionFail("rate_limited", 429, code);
    if (res.status === 400 || res.status === 409) throw new NotionFail("bad_request", res.status, code);
    if (write) throw new NotionFail("unconfirmed", res.status, code);
    throw new NotionFail("upstream_error", res.status, code);
  }

  async query(dataSourceId: string, body: Record<string, unknown> = {}): Promise<NotionPage[]> {
    const out: NotionPage[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const r = await this.send("POST", `/data_sources/${dataSourceId}/query`, { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }, false);
      if (!r || !Array.isArray(r.results)) throw new NotionFail("bad_shape", 200);
      for (const p of r.results) if (p && p.object === "page" && p.properties) out.push(p);
      if (!r.has_more || !r.next_cursor) break;
      cursor = r.next_cursor;
    }
    return out;
  }

  async tasks(): Promise<Task[]> {
    const rows = await this.query(DS.tasks, { filter: { property: "Status", status: { does_not_equal: "Done" } } });
    return rows.map(normTask);
  }
  /** Tasks marked Done since midnight (by when they were last changed). */
  async doneSince(isoMidnight: string): Promise<Task[]> {
    const rows = await this.query(DS.tasks, { filter: { and: [
      { property: "Status", status: { equals: "Done" } },
      { timestamp: "last_edited_time", last_edited_time: { on_or_after: isoMidnight } },
    ] } });
    return rows.map(normTask);
  }
  async projects(): Promise<Project[]> {
    return (await this.query(DS.projects)).map(normProject);
  }
  async bills(): Promise<Bill[]> {
    return (await this.query(DS.bills)).map(normBill);
  }
  async sleep(): Promise<SleepEntry[]> {
    const rows = await this.query(DS.sleep, { sorts: [{ timestamp: "created_time", direction: "descending" }] });
    return rows.map(normSleep).filter((x) => x.night);
  }

  /** A project's page content (notes, contacts), read only. Checks it really is a project first. */
  async projectContent(pageId: string): Promise<{ blocks: NoteBlock[]; truncated: boolean }> {
    const id = idOf(pageId);
    if (!/^[0-9a-f]{32}$/.test(id)) throw new NotionFail("bad_request", 400, "bad id");
    const p = await this.send("GET", `/pages/${id}`, undefined, false);
    if (idOf(p?.parent?.data_source_id || "") !== idOf(DS.projects)) throw new NotionFail("not_found", 404);
    const blocks: NoteBlock[] = [];
    let cursor: string | undefined, truncated = false;
    for (let i = 0; i < 3; i++) {
      const q = "?page_size=100" + (cursor ? "&start_cursor=" + encodeURIComponent(cursor) : "");
      const r = await this.send("GET", `/blocks/${id}/children${q}`, undefined, false);
      if (!r || !Array.isArray(r.results)) throw new NotionFail("bad_shape", 200);
      for (const b of r.results) { const n = normBlock(b); if (n) blocks.push(n); }
      if (!r.has_more || !r.next_cursor) { cursor = undefined; break; }
      cursor = r.next_cursor;
    }
    if (cursor) truncated = true;
    return { blocks, truncated };
  }

  /* ---------- writes: only these four, nothing else ---------- */

  /** Confirms a page really is a row in the Tasks database before changing it. */
  private async assertTask(pageId: string): Promise<string> {
    const id = idOf(pageId);
    if (!/^[0-9a-f]{32}$/.test(id)) throw new NotionFail("bad_request", 400, "bad id");
    const p = await this.send("GET", `/pages/${id}`, undefined, false);
    const parent = p?.parent || {};
    const ds = idOf(parent.data_source_id || "");
    if (ds !== idOf(DS.tasks) || p.in_trash === true || p.archived === true) throw new NotionFail("not_a_task", 400);
    return id;
  }

  async setTaskStatus(pageId: string, status: string): Promise<void> {
    if (!(TASK_STATUSES as readonly string[]).includes(status)) throw new NotionFail("bad_request", 400, "status");
    const id = await this.assertTask(pageId);
    await this.send("PATCH", `/pages/${id}`, { properties: { Status: { status: { name: status } } } }, true);
  }

  async setTop3(pageId: string, on: boolean): Promise<void> {
    const id = await this.assertTask(pageId);
    await this.send("PATCH", `/pages/${id}`, { properties: { "Top 3": { checkbox: on === true } } }, true);
  }

  async createTask(t: NewTask): Promise<void> {
    const properties: Record<string, unknown> = {
      Task: { title: [{ text: { content: t.title } }] },
      Status: { status: { name: "Not started" } },
    };
    if (t.block) properties["Time block"] = { select: { name: t.block } };
    if (t.due) properties["Due"] = { date: { start: t.due } };
    await this.send("POST", "/pages", { parent: { type: "data_source_id", data_source_id: DS.tasks }, properties }, true);
  }

  /** Confirms a page really is a row in the Bills database before changing it. */
  private async assertBill(pageId: string): Promise<string> {
    const id = idOf(pageId);
    if (!/^[0-9a-f]{32}$/.test(id)) throw new NotionFail("bad_request", 400, "bad id");
    const p = await this.send("GET", `/pages/${id}`, undefined, false);
    if (idOf(p?.parent?.data_source_id || "") !== idOf(DS.bills) || p.in_trash === true || p.archived === true) throw new NotionFail("not_a_bill", 400);
    return id;
  }

  /** Ticks or unticks a bill's Paid box. It does not pay anything. */
  async setBillPaid(pageId: string, paid: boolean): Promise<void> {
    const id = await this.assertBill(pageId);
    await this.send("PATCH", `/pages/${id}`, { properties: { Paid: { checkbox: paid === true } } }, true);
  }

  /** Adds a new bill, unpaid. */
  async createBill(b: NewBill): Promise<void> {
    const properties: Record<string, unknown> = { Bill: { title: [{ text: { content: b.name } }] } };
    if (b.amount != null) properties["Amount"] = { number: b.amount };
    if (b.due) properties["Due"] = { date: { start: b.due } };
    if (b.repeats) properties["Repeats"] = { select: { name: b.repeats } };
    if (b.type) properties["Type"] = { select: { name: b.type } };
    await this.send("POST", "/pages", { parent: { type: "data_source_id", data_source_id: DS.bills }, properties }, true);
  }

  async createSleep(e: NewSleep): Promise<void> {
    const rt = (v: string) => ({ rich_text: v ? [{ text: { content: v } }] : [] });
    await this.send("POST", "/pages", {
      parent: { type: "data_source_id", data_source_id: DS.sleep },
      properties: {
        "Night of": { title: [{ text: { content: e.night } }] },
        Bedtime: rt(e.bed),
        "Wake-up": rt(e.wake),
        "Hours slept": { number: e.hours },
      },
    }, true);
  }
}

/* ---------- reading property values ---------- */
const prop = (p: NotionPage, name: string) => p.properties?.[name];
const plain = (arr: unknown): string => (Array.isArray(arr) ? arr.map((t: any) => t?.plain_text ?? "").join("") : "");
export const text = (v: any): string => (!v ? "" : v.type === "title" ? plain(v.title) : v.type === "rich_text" ? plain(v.rich_text) : "");
export const sel = (v: any): string => (v?.type === "select" ? v.select?.name || "" : v?.type === "status" ? v.status?.name || "" : "");
export const check = (v: any): boolean => v?.type === "checkbox" && v.checkbox === true;
export const num = (v: any): number | null => (v?.type === "number" && typeof v.number === "number" ? v.number : null);
export const day = (v: any): string | null => (v?.type === "date" && v.date?.start ? String(v.date.start).slice(0, 10) : null);
export const rel = (v: any): string[] => (v?.type === "relation" && Array.isArray(v.relation) ? v.relation.map((r: any) => idOf(r.id)) : []);
const created = (p: NotionPage, v: any): string => (v?.type === "created_time" && v.created_time) || p.created_time || "";

export function normTask(p: NotionPage): Task {
  return {
    id: idOf(p.id), url: p.url,
    title: text(prop(p, "Task")) || "Untitled",
    status: sel(prop(p, "Status")) || "Not started",
    top3: check(prop(p, "Top 3")),
    block: sel(prop(p, "Time block")),
    area: sel(prop(p, "Area")),
    due: day(prop(p, "Due")),
    projectIds: rel(prop(p, "Project")),
  };
}
export function normProject(p: NotionPage): Project {
  return {
    id: idOf(p.id), url: p.url,
    name: text(prop(p, "Project")) || "Untitled",
    status: sel(prop(p, "Status")),
    next: text(prop(p, "Next step")),
    focus: check(prop(p, "Focus")),
    deadline: day(prop(p, "Deadline")),
  };
}
export function normBill(p: NotionPage): Bill {
  return {
    id: idOf(p.id), url: p.url,
    name: text(prop(p, "Bill")) || "Bill",
    amount: num(prop(p, "Amount")),
    type: sel(prop(p, "Type")),
    repeats: sel(prop(p, "Repeats")),
    paid: check(prop(p, "Paid")),
    due: day(prop(p, "Due")),
  };
}
export function normSleep(p: NotionPage): SleepEntry {
  return {
    id: idOf(p.id),
    night: text(prop(p, "Night of")).trim(),
    bed: text(prop(p, "Bedtime")).trim(),
    wake: text(prop(p, "Wake-up")).trim(),
    hours: num(prop(p, "Hours slept")),
    logged: created(p, prop(p, "Logged")),
  };
}

/* ---------- project notes ---------- */
/** Keeps only web, mail, and phone links; Notion's own links become full addresses. */
export function safeHref(h: unknown): string | undefined {
  if (typeof h !== "string" || !h) return undefined;
  if (h.startsWith("/")) return "https://www.notion.so" + h;
  try {
    const u = new URL(h);
    return ["https:", "http:", "mailto:", "tel:"].includes(u.protocol) ? u.toString() : undefined;
  } catch { return undefined; }
}
function rich(arr: unknown): RichBit[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((r: any) => {
    const a = r?.annotations || {};
    const bit: RichBit = { t: String(r?.plain_text ?? "") };
    if (a.bold) bit.b = true; if (a.italic) bit.i = true; if (a.code) bit.c = true; if (a.strikethrough) bit.s = true;
    const href = safeHref(r?.href); if (href) bit.href = href;
    return bit;
  }).filter((b) => b.t);
}
const KIND: Record<string, NoteBlock["kind"]> = {
  paragraph: "p", heading_1: "h1", heading_2: "h2", heading_3: "h3", bulleted_list_item: "li", numbered_list_item: "ol",
  to_do: "todo", quote: "quote", callout: "callout", toggle: "toggle", code: "code",
};
export function normBlock(b: any): NoteBlock | null {
  if (!b || b.object !== "block" || b.in_trash === true || b.archived === true) return null;
  const type = String(b.type || ""), v = b[type] || {};
  const more = b.has_children === true && type !== "child_page" && type !== "child_database";
  if (type === "divider") return { kind: "divider", text: [] };
  if (KIND[type]) {
    const n: NoteBlock = { kind: KIND[type], text: rich(v.rich_text) };
    if (type === "to_do") n.checked = v.checked === true;
    if (more) n.more = true;
    return n;
  }
  if (type === "bookmark" || type === "link_preview" || type === "embed") {
    const href = safeHref(v.url);
    return href ? { kind: "link", text: [{ t: (rich(v.caption).map((x) => x.t).join("") || href), href }] } : null;
  }
  if (type === "child_page" || type === "child_database") return { kind: "other", text: [{ t: (v.title || "A page") + " (open in Notion)" }] };
  if (type === "image" || type === "file" || type === "pdf" || type === "video" || type === "audio") return { kind: "other", text: [{ t: "An attachment (open in Notion to see it)" }] };
  if (type === "table" || type === "column_list" || type === "synced_block") return { kind: "other", text: [{ t: "More here in Notion" }], more: true };
  return null;
}
