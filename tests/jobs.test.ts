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
    applied: "2026-11-16", followUp: null, next: "Message on LinkedIn", contactName: "Chris", contactLink: "https://linkedin.com/in/x", postingLink: null, notes: "Met at open house" });
  assert.equal(webLink({ type: "url", url: "" }), null);
  assert.equal(normJob({ id: "x", url: "", created_time: "", properties: {} } as any).company, "Untitled");
});

const job = (o: Partial<Job>): Job => ({ id: o.company || "x", url: "", company: "x", role: "", status: "Applied", applied: null, followUp: null, next: "", contactName: "", contactLink: null, postingLink: null, notes: "", ...o });

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
  assert.deepEqual(R.jobCounts(jobs), { Interested: 1, Applied: 1, Interviewing: 1, Offer: 0, Rejected: 1, Withdrawn: 0 });
});

test("the jobs page is read only", async () => {
  const app = createApp({ notion: () => null, demo: false, google: () => ({ clientId: "", clientSecret: "", refreshToken: "" }) });
  const r = await (await app.request("http://hw.test/api/jobs")).json();
  assert.equal(r.source, "sample");
  assert.ok(r.items.length > 0);
  for (const m of ["POST", "PATCH", "DELETE"]) {
    const w = await app.request("http://hw.test/api/jobs", { method: m, headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(w.status, 404, m);
  }
});
