import { test } from "node:test";
import assert from "node:assert/strict";
import { DS, NotionFail, NotionReader } from "../server/notion.js";
import { createApp } from "../server/app.js";

const TASK_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const taskPage = { object: "page", id: TASK_ID, parent: { type: "data_source_id", data_source_id: DS.tasks, database_id: "x" }, in_trash: false, properties: {} };
const billPage = { ...taskPage, parent: { type: "data_source_id", data_source_id: DS.bills } };

type Reply = { status?: number; body?: unknown; throws?: boolean };
function fake(replies: Reply[], seen: any[]) {
  return (async (url: string, init: any) => {
    seen.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    const r = replies.shift();
    if (!r) throw new Error("unexpected extra request");
    if (r.throws) throw new TypeError("network");
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status || 200 });
  }) as typeof fetch;
}
const isCode = (code: string) => (e: unknown) => e instanceof NotionFail && e.code === code;

test("marking done checks the page is a task, then patches only Status", async () => {
  const seen: any[] = [];
  const n = new NotionReader("t", fake([{ body: taskPage }, { body: { object: "page" } }], seen));
  await n.setTaskStatus(TASK_ID, "Done");
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].url, `https://api.notion.com/v1/pages/${TASK_ID}`);
  assert.equal(seen[1].method, "PATCH");
  assert.deepEqual(seen[1].body, { properties: { Status: { status: { name: "Done" } } } });
});

test("undo restores the earlier status, and odd statuses are refused", async () => {
  const seen: any[] = [];
  const n = new NotionReader("t", fake([{ body: taskPage }, { body: {} }], seen));
  await n.setTaskStatus(TASK_ID, "In progress");
  assert.deepEqual(seen[1].body.properties.Status, { status: { name: "In progress" } });
  await assert.rejects(new NotionReader("t", fake([], [])).setTaskStatus(TASK_ID, "Archived"), isCode("bad_request"));
});

test("will not touch a page outside Tasks, like a bill", async () => {
  const seen: any[] = [];
  const n = new NotionReader("t", fake([{ body: billPage }], seen));
  await assert.rejects(n.setTop3(TASK_ID, true), isCode("not_a_task"));
  assert.equal(seen.length, 1, "no PATCH was sent");
});

test("top 3 patches only the checkbox", async () => {
  const seen: any[] = [];
  await new NotionReader("t", fake([{ body: taskPage }, { body: {} }], seen)).setTop3(TASK_ID, false);
  assert.deepEqual(seen[1].body, { properties: { "Top 3": { checkbox: false } } });
});

test("new task and new sleep entry go to the right databases with the right fields", async () => {
  const seen: any[] = [];
  const n = new NotionReader("t", fake([{ body: {} }, { body: {} }, { body: {} }], seen));
  await n.createTask({ title: "Call pharmacy", block: "Lunch", due: "2026-11-05" });
  assert.deepEqual(seen[0].body, {
    parent: { type: "data_source_id", data_source_id: DS.tasks },
    properties: { Task: { title: [{ text: { content: "Call pharmacy" } }] }, Status: { status: { name: "Not started" } }, "Time block": { select: { name: "Lunch" } }, Due: { date: { start: "2026-11-05" } } },
  });
  await n.createTask({ title: "Plain", block: "", due: null });
  assert.deepEqual(Object.keys(seen[1].body.properties), ["Task", "Status"]);
  await n.createSleep({ night: "Nov 3", bed: "3:45 am", wake: "", hours: 6.5 });
  assert.deepEqual(seen[2].body, {
    parent: { type: "data_source_id", data_source_id: DS.sleep },
    properties: { "Night of": { title: [{ text: { content: "Nov 3" } }] }, Bedtime: { rich_text: [{ text: { content: "3:45 am" } }] }, "Wake-up": { rich_text: [] }, "Hours slept": { number: 6.5 } },
  });
});

test("writes never retry, and unknown results say unconfirmed", async () => {
  for (const r of [{ throws: true }, { status: 500 }, { status: 502 }] as Reply[]) {
    const seen: any[] = [];
    await assert.rejects(new NotionReader("t", fake([r], seen)).createTask({ title: "x", block: "", due: null }), isCode("unconfirmed"));
    assert.equal(seen.length, 1, "exactly one request");
  }
  const seen: any[] = [];
  await assert.rejects(new NotionReader("t", fake([{ status: 429 }], seen)).createSleep({ night: "Nov 3", bed: "", wake: "", hours: 1 }), isCode("rate_limited"));
  assert.equal(seen.length, 1, "no retry after a rate limit on a write");
});

/* ---------- routes ---------- */
function appWith(n: Partial<NotionReader> | null) {
  return createApp({ notion: () => n as NotionReader | null, demo: false });
}
const post = (app: ReturnType<typeof appWith>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request("http://hw.test" + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("routes check every value before calling Notion", async () => {
  const calls: unknown[] = [];
  const n = { createTask: async (t: unknown) => { calls.push(t); }, createSleep: async (e: unknown) => { calls.push(e); }, setTaskStatus: async () => {}, setTop3: async () => {} };
  const app = appWith(n);
  const bad: Array<[string, unknown]> = [
    ["/api/tasks", { title: "" }],
    ["/api/tasks", { title: "x".repeat(201) }],
    ["/api/tasks", { title: "ok", block: "Midnight" }],
    ["/api/tasks", { title: "ok", due: "2026-13-40" }],
    ["/api/tasks", { title: "ok", due: "tomorrow" }],
    ["/api/sleep", { night: "Nov 3", hours: 25 }],
    ["/api/sleep", { night: "Nov 3", hours: "7" }],
    ["/api/sleep", { night: "", hours: 7 }],
    ["/api/tasks/abc/status", { status: "Deleted" }],
    ["/api/tasks/abc/top3", { top3: "yes" }],
  ];
  for (const [path, b] of bad) assert.equal((await post(app, path, b)).status, 400, path + " " + JSON.stringify(b));
  assert.equal(calls.length, 0);
  assert.equal((await post(app, "/api/tasks", { title: " Call ", block: "Lunch", due: "2026-11-05" })).status, 200);
  assert.deepEqual(calls[0], { title: "Call", block: "Lunch", due: "2026-11-05" });
});

test("writes must be JSON from the same site", async () => {
  const app = appWith({ createTask: async () => {} });
  const form = await app.request("http://hw.test/api/tasks", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "title=x" });
  assert.equal(form.status, 415);
  assert.equal((await post(app, "/api/tasks", { title: "x" }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await post(app, "/api/tasks", { title: "x" }, { Origin: "http://hw.test" })).status, 200);
});

test("an unknown write result comes back as unconfirmed", async () => {
  const app = appWith({ createSleep: async () => { throw new NotionFail("unconfirmed", 0); } });
  const r = await post(app, "/api/sleep", { night: "Nov 3", bed: "", wake: "", hours: 7 });
  assert.equal(r.status, 504);
  assert.equal((await r.json()).error.code, "unconfirmed");
});

test("there is no route to delete anything or touch bills", async () => {
  const app = appWith({});
  for (const [m, p] of [["DELETE", "/api/tasks/abc"], ["POST", "/api/bills"], ["POST", "/api/bills/abc/paid"], ["PATCH", "/api/tasks/abc"]]) {
    const r = await app.request("http://hw.test" + p, { method: m, headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 404, m + " " + p);
  }
});
