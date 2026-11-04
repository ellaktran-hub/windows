import { test } from "node:test";
import assert from "node:assert/strict";
import { DS, NOTION_VERSION, NotionFail, NotionReader, type NotionPage } from "../server/notion.js";

const title = (s: string) => ({ type: "title", title: [{ plain_text: s }] });
const rt = (s: string) => ({ type: "rich_text", rich_text: [{ plain_text: s }] });
const select = (s: string | null) => ({ type: "select", select: s ? { name: s } : null });
const page = (id: string, properties: Record<string, unknown>, created = "2026-11-04T12:00:00.000Z"): NotionPage =>
  ({ object: "page", id, url: "https://www.notion.so/" + id.replace(/-/g, ""), created_time: created, properties } as any);

function fakeFetch(replies: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>, seen: any[] = []) {
  return (async (url: string, init: any) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    const r = replies.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status || 200, headers: r.headers });
  }) as typeof fetch;
}

test("tasks: query filters out Done, sends version and token only in headers, reads every property", async () => {
  const seen: any[] = [];
  const t = page("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", {
    Task: title("Pack books"), Status: { type: "status", status: { name: "In progress" } },
    "Top 3": { type: "checkbox", checkbox: true }, "Time block": select("Evening"), Area: select("Home"),
    Due: { type: "date", date: { start: "2026-11-04T09:00:00.000-05:00" } },
    Project: { type: "relation", relation: [{ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }] },
    Place: { type: "place", place: null },
  });
  const r = new NotionReader("test-token", fakeFetch([{ body: { results: [t], has_more: false, next_cursor: null } }], seen));
  const [x] = await r.tasks();
  assert.deepEqual(x, { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", url: t.url, title: "Pack books", status: "In progress", top3: true, block: "Evening", area: "Home", due: "2026-11-04", projectIds: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"] });
  assert.equal(seen[0].url, `https://api.notion.com/v1/data_sources/${DS.tasks}/query`);
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers["Notion-Version"], NOTION_VERSION);
  assert.equal(seen[0].init.headers.Authorization, "Bearer test-token");
  assert.deepEqual(seen[0].body.filter, { property: "Status", status: { does_not_equal: "Done" } });
  assert.ok(!JSON.stringify(seen[0].body).includes("test-token"));
});

test("follows pages of results", async () => {
  const seen: any[] = [];
  const b = (id: string) => page(id, { Bill: title("B" + id), Amount: { type: "number", number: 12.5 }, Paid: { type: "checkbox", checkbox: false } });
  const r = new NotionReader("t", fakeFetch([
    { body: { results: [b("1")], has_more: true, next_cursor: "c2" } },
    { body: { results: [b("2")], has_more: false, next_cursor: null } },
  ], seen));
  const bills = await r.bills();
  assert.deepEqual(bills.map((x) => x.name), ["B1", "B2"]);
  assert.equal(seen[1].body.start_cursor, "c2");
  assert.equal(bills[0].amount, 12.5);
  assert.equal(bills[0].due, null);
});

test("projects and sleep", async () => {
  const p = page("p1", { Project: title("Move"), Status: select("Urgent"), "Next step": rt("Email landlord"), Focus: { type: "checkbox", checkbox: true }, Deadline: { type: "date", date: null } });
  const s1 = page("s1", { "Night of": title(" Nov 3 "), Bedtime: rt("4am"), "Wake-up": rt("11am"), "Hours slept": { type: "number", number: 7 }, Logged: { type: "created_time", created_time: "2026-11-04T15:00:00.000Z" } });
  const s2 = page("s2", { "Night of": title(""), "Hours slept": { type: "number", number: null } });
  const seen: any[] = [];
  const r = new NotionReader("t", fakeFetch([{ body: { results: [p], has_more: false } }, { body: { results: [s1, s2], has_more: false } }], seen));
  assert.deepEqual(await r.projects(), [{ id: "p1", url: p.url, name: "Move", status: "Urgent", next: "Email landlord", focus: true, deadline: null }]);
  const sleep = await r.sleep();
  assert.deepEqual(sleep, [{ id: "s1", night: "Nov 3", bed: "4am", wake: "11am", hours: 7, logged: "2026-11-04T15:00:00.000Z" }]);
  assert.deepEqual(seen[1].body.sorts, [{ timestamp: "created_time", direction: "descending" }]);
});

test("errors become calm codes", async () => {
  const cases: Array<[number, string]> = [[401, "unauthorized"], [404, "not_shared"], [400, "bad_request"], [500, "upstream_error"], [503, "upstream_error"]];
  for (const [status, code] of cases) {
    const r = new NotionReader("t", fakeFetch([{ status, body: { object: "error", code: "x" } }]));
    await assert.rejects(r.tasks(), (e: unknown) => e instanceof NotionFail && e.code === code);
  }
  const net = new NotionReader("t", (async () => { throw new TypeError("fetch failed"); }) as any);
  await assert.rejects(net.tasks(), (e: unknown) => e instanceof NotionFail && e.code === "upstream_error");
});

test("one polite retry after a rate limit, then a calm error", async () => {
  const ok = new NotionReader("t", fakeFetch([{ status: 429, body: {}, headers: { "retry-after": "0" } }, { body: { results: [], has_more: false } }]));
  assert.deepEqual(await ok.projects(), []);
  const bad = new NotionReader("t", fakeFetch([{ status: 429, body: {}, headers: { "retry-after": "0" } }, { status: 429, body: {}, headers: { "retry-after": "0" } }]));
  await assert.rejects(bad.projects(), (e: unknown) => e instanceof NotionFail && e.code === "rate_limited");
});
