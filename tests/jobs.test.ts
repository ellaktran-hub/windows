import { test } from "node:test";
import assert from "node:assert/strict";
import { DS, NotionReader, normJob, webLink } from "../server/notion.js";
import { createApp } from "../server/app.js";
import * as R from "../src/rules.js";
import type { Job } from "../shared/types.js";

const T = "2026-11-16";
const rt = (t: string) => ({ type: "rich_text", rich_text: t ? [{ plain_text: t }] : [] });

test("reads every Job Applications property", async () => {
  const seen: any[] = [];
  const row = { object: "page", id: "cccccccc-cccc-cccc-cccc-cccccccccccc", url: "https://www.notion.so/c", created_time: "", properties: {
    Company: { type: "title", title: [{ plain_text: "PTC" }] }, Role: rt("Sales Intern"), Status: { type: "select", select: { name: "Applied" } },
    "Date applied": { type: "date", date: { start: "2026-11-16" } }, "Follow-up date": { type: "date", date: null },
    "Next step": rt("Message on LinkedIn"), "Contact name": rt("Chris"), "Contact link": { type: "url", url: "linkedin.com/in/x" },
    "Job posting link": { type: "url", url: "javascript:alert(1)" }, Notes: rt("Met at open house"),
  } };
  const f = (async (url: string, init: any) => { seen.push([init.method, url]); return new Response(JSON.stringify({ results: [row], has_more: false })); }) as typeof fetch;
  const [j] = await new NotionReader("t", f).jobs();
  assert.deepEqual(seen, [["POST", `https://api.notion.com/v1/data_sources/${DS.jobs}/query`]], "one read, nothing else");
  assert.deepEqual(j, { id: "cccccccccccccccccccccccccccccccc", url: "https://www.notion.so/c", company: "PTC", role: "Sales Intern", status: "Applied",
    applied: "2026-11-16", followUp: null, next: "Message on LinkedIn", contactName: "Chris", contactLink: "https://linkedin.com/in/x", postingLink: null, notes: "Met at open house", priority: "", how: [], posted: "", lastContacted: null, setup: "", location: "" });
  assert.equal(webLink({ type: "url", url: "" }), null);
  assert.equal(normJob({ id: "x", url: "", created_time: "", properties: {} } as any).company, "Untitled");
});

const job = (o: Partial<Job>): Job => ({ id: o.company || "x", url: "", company: "x", role: "", status: "Applied", applied: null, followUp: null, next: "", contactName: "", contactLink: null, postingLink: null, notes: "", priority: "", how: [], posted: "", lastContacted: null, setup: "", location: "", ...o } as Job);

test("follow-up marks: overdue, today, soon, later, none, and never for closed ones", () => {
  assert.deepEqual(R.followUp(job({ followUp: "2026-11-14" }), T), { kind: "overdue", days: -2 });
  assert.equal(R.followUp(job({ followUp: T }), T).kind, "today");
  assert.equal(R.followUp(job({ followUp: "2026-11-20" }), T).kind, "soon");
  assert.equal(R.followUp(job({ followUp: "2026-12-20" }), T).kind, "later");
  assert.equal(R.followUp(job({}), T).kind, "none");
  assert.equal(R.followUp(job({ status: "Rejected", followUp: "2026-11-01" }), T).kind, "closed");
});

test("sorting and counts", () => {
  const jobs = [
    job({ company: "A", status: "Interviewing", followUp: "2026-11-30" }),
    job({ company: "B", status: "Interested", followUp: "2026-11-18" }),
    job({ company: "C", status: "Rejected", followUp: "2026-11-01" }),
    job({ company: "D", status: "Applied" }),
  ];
  assert.deepEqual(R.sortJobs(jobs, "status").map((j) => j.company), ["B", "D", "A", "C"]);
  assert.deepEqual(R.sortJobs(jobs, "followup").map((j) => j.company), ["B", "A", "D", "C"], "closed ones last, no date after dated");
  const pr = [job({ company: "P1", priority: "Low", followUp: "2026-11-17" }), job({ company: "P2", priority: "High" }), job({ company: "P3", priority: "High", status: "Rejected" }), job({ company: "P4" }), job({ company: "P5", priority: "Top", followUp: "2026-12-30" })];
  assert.deepEqual(R.sortJobs(pr, "priority").map((j) => j.company), ["P5", "P2", "P1", "P4", "P3"], "top, then high, closed last");
  assert.deepEqual(R.jobCounts(jobs), { Interested: 1, Applied: 1, Interviewing: 1, Offer: 0, Rejected: 1, Withdrawn: 0 });
});

test("adding and editing a job: checked values, every field sent, never deleted", async () => {
  const calls: any[] = [];
  const app = createApp({ notion: () => ({ createJob: async (j: unknown) => { calls.push(["new", j]); }, updateJob: async (id: string, j: unknown) => { calls.push(["edit", id, j]); } }) as any, demo: false, google: () => ({ clientId: "", clientSecret: "", refreshToken: "" }) });
  const post = (path: string, b: unknown) => app.request("http://hw.test" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  for (const b of [{}, { company: "" }, { company: "A", status: "Ghosted" }, { company: "A", applied: "soon" }, { company: "A", postingLink: "javascript:alert(1)" }, { company: "A", notes: "x".repeat(2001) }])
    assert.equal((await post("/api/jobs", b)).status, 400, JSON.stringify(b));
  assert.equal(calls.length, 0);
  assert.equal((await post("/api/jobs", { company: " PTC ", role: "Sales Intern", status: "Applied", applied: "2026-11-16", contactLink: "linkedin.com/in/chris" })).status, 200);
  assert.deepEqual(calls[0], ["new", { company: "PTC", role: "Sales Intern", status: "Applied", applied: "2026-11-16", followUp: null, next: "", contactName: "", contactLink: "https://linkedin.com/in/chris", postingLink: null, notes: "", priority: "", how: [], posted: "", lastContacted: null, setup: "", location: "" }]);
  for (const b of [{ company: "A", priority: "Urgent" }, { company: "A", how: ["Carrier pigeon"] }, { company: "A", how: "Online" }, { company: "A", posted: "Maybe" }, { company: "A", lastContacted: "yesterday" }, { company: "A", setup: "Sometimes" }])
    assert.equal((await post("/api/jobs", b)).status, 400, JSON.stringify(b));
  assert.equal((await post("/api/jobs/abc", { company: "PTC", status: "Interviewing", followUp: "2026-11-20" })).status, 200);
  assert.equal(calls[1][0], "edit"); assert.equal(calls[1][1], "abc"); assert.equal(calls[1][2].followUp, "2026-11-20");
  for (const m of ["PATCH", "DELETE"]) {
    const w = await app.request("http://hw.test/api/jobs/abc", { method: m, headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(w.status, 404, m + " is not a route");
  }
});

test("job writes go only to real Job Applications rows", async () => {
  const { jobProps } = await import("../server/notion.js");
  const seen: any[] = [];
  const replies = [{ object: "page", parent: { type: "data_source_id", data_source_id: DS.jobs } }, {}, { object: "page", parent: { type: "data_source_id", data_source_id: DS.bills } }];
  const f = (async (url: string, init: any) => { seen.push([init.method, url, init.body ? JSON.parse(init.body) : null]); return new Response(JSON.stringify(replies.shift())); }) as typeof fetch;
  const n = new NotionReader("t", f);
  const input = { company: "PTC", role: "", status: "", applied: null, followUp: null, next: "", contactName: "", contactLink: null, postingLink: null, notes: "", priority: "High", how: ["Online", "In person"], posted: "Posted", lastContacted: null, setup: "Hybrid", location: "Seaport office" };
  await n.updateJob("dddddddddddddddddddddddddddddddd", input);
  assert.equal(seen[1][0], "PATCH");
  assert.deepEqual(seen[1][2], { properties: jobProps(input) });
  assert.deepEqual(jobProps(input)["Follow-up date"], { date: null }, "a cleared date is cleared in Notion");
  assert.deepEqual(jobProps(input)["How I applied"], { multi_select: [{ name: "Online" }, { name: "In person" }] });
  assert.deepEqual(jobProps(input)["Priority"], { select: { name: "High" } });
  assert.deepEqual(jobProps(input)["Work setup"], { select: { name: "Hybrid" } });
  assert.deepEqual(jobProps(input)["Location"], { rich_text: [{ text: { content: "Seaport office" } }] });
  await assert.rejects(n.updateJob("dddddddddddddddddddddddddddddddd", input));
  assert.equal(seen.length, 3, "no PATCH for a row outside Job Applications");
});

test("contact links can be web or email addresses", async () => {
  const { cleanLink } = await import("../server/notion.js");
  assert.equal(cleanLink("sgoldman@ptc.com"), "mailto:sgoldman@ptc.com");
  assert.equal(cleanLink("mailto:sgoldman@ptc.com"), "mailto:sgoldman@ptc.com");
  assert.equal(cleanLink("linkedin.com/in/x"), "https://linkedin.com/in/x");
  assert.equal(cleanLink("javascript:alert(1)"), null);
  assert.equal(cleanLink("mailto:not-an-email"), null);
  assert.equal(webLink({ type: "url", url: "mailto:sgoldman@ptc.com" }), "mailto:sgoldman@ptc.com");
});
