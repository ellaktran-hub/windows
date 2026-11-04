// Reads the Notion "Life planner" through Notion's REST API.
// Server side only: the token is passed in by the server entry and never
// sent to the browser or written to logs.
//
// This file only reads. There is no delete, archive, or trash call here.

import type { Bill, Project, SleepEntry, Task } from "../shared/types.js";

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

export class NotionReader {
  // base can point at a pretend Notion server, for local tests only.
  constructor(private token: string, private fetchImpl: Fetch = (i, init) => fetch(i, init), private base: string = NOTION_BASE) {}

  private async post(path: string, body: unknown, retried = false): Promise<any> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + this.token,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch {
      throw new NotionFail(ctl.signal.aborted ? "timeout" : "upstream_error", 0);
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return res.json();

    let code = "";
    try { code = ((await res.json()) as { code?: string }).code || ""; } catch { /* no body */ }
    // Reads are safe to try once more after Notion asks us to slow down.
    if (res.status === 429 && !retried) {
      const wait = Math.min(Number(res.headers.get("retry-after") || 1), 5) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return this.post(path, body, true);
    }
    if (res.status === 401) throw new NotionFail("unauthorized", 401, code);
    if (res.status === 403 || res.status === 404) throw new NotionFail("not_shared", res.status, code);
    if (res.status === 429) throw new NotionFail("rate_limited", 429, code);
    if (res.status === 400) throw new NotionFail("bad_request", 400, code);
    throw new NotionFail("upstream_error", res.status, code);
  }

  async query(dataSourceId: string, body: Record<string, unknown> = {}): Promise<NotionPage[]> {
    const out: NotionPage[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const r = await this.post(`/data_sources/${dataSourceId}/query`, { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
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
