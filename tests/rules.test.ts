import { test } from "node:test";
import assert from "node:assert/strict";
import * as R from "../src/rules.js";
import type { Bill, Project, SleepEntry, Task } from "../shared/types.js";

const T = "2026-11-04";
const task = (o: Partial<Task>): Task => ({ id: o.title || "x", url: "", title: "x", status: "Not started", top3: false, block: "", area: "", due: null, projectIds: [], ...o });

test("top 3 and due today follow the rules", () => {
  const tasks = [
    task({ title: "a", top3: true }),
    task({ title: "b", top3: true, status: "Done" }),
    task({ title: "c", due: "2026-11-03" }),
    task({ title: "d", due: T, top3: true }),
    task({ title: "e", due: "2026-11-05" }),
  ];
  assert.deepEqual(R.top3(tasks).map((x) => x.title), ["d", "a"]);
  assert.deepEqual(R.dueToday(tasks, T).map((x) => x.title), ["c"]);
});

test("buckets", () => {
  const b = R.buckets([task({ title: "o", due: "2026-11-01" }), task({ title: "t", due: T }), task({ title: "w", due: "2026-11-11" }), task({ title: "l", due: "2026-11-12" }), task({ title: "n" })], T);
  assert.deepEqual(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.map((x) => x.title)])), { overdue: ["o"], today: ["t"], week: ["w"], later: ["l"], none: ["n"] });
});

test("start with: top 3, then due, then urgent next step, then rest", () => {
  const urgent: Project[] = [{ id: "p", url: "", name: "P", status: "Urgent", next: "Do the thing", focus: false, deadline: null }];
  assert.equal(R.startWith(T, [task({ title: "due", due: T }), task({ title: "pinned", top3: true })], urgent), "pinned");
  assert.equal(R.startWith(T, [task({ title: "due", due: "2026-11-02" })], urgent), "due");
  assert.equal(R.startWith(T, [task({ title: "later", due: "2026-12-01" })], urgent), "Do the thing");
  assert.equal(R.startWith(T, [], []), R.REST);
  assert.equal(R.startWith(T, null, null), null);
});

test("coming up: 14 days for deadlines and unpaid bills, 7 days for tasks", () => {
  const projects: Project[] = [{ id: "p", url: "", name: "P", status: "Active", next: "", focus: false, deadline: "2026-11-18" }, { id: "q", url: "", name: "Q", status: "Active", next: "", focus: false, deadline: "2026-11-19" }];
  const bills: Bill[] = [
    { id: "b1", url: "", name: "Rent", amount: 1, type: "", repeats: "", paid: false, due: "2026-11-10" },
    { id: "b2", url: "", name: "Paid", amount: 1, type: "", repeats: "", paid: true, due: "2026-11-10" },
  ];
  const tasks = [task({ title: "soon", due: "2026-11-11" }), task({ title: "far", due: "2026-11-12" })];
  assert.deepEqual(R.comingUp(T, tasks, projects, bills).map((i) => i.title), ["Rent", "soon", "P"]);
});

test("sleep: newest entry per night wins, last night, count of 7", () => {
  const rows: SleepEntry[] = [
    { id: "1", night: "Nov 3", bed: "", wake: "", hours: 5, logged: "2026-11-04T10:00:00Z" },
    { id: "2", night: "nov 3", bed: "", wake: "", hours: 7, logged: "2026-11-04T12:00:00Z" },
    { id: "3", night: "Nov 1", bed: "", wake: "", hours: 6, logged: "2026-11-02T12:00:00Z" },
    { id: "4", night: "Oct 20", bed: "", wake: "", hours: 6, logged: "2026-10-21T12:00:00Z" },
  ];
  assert.equal(R.lastNight(rows, T)?.hours, 7);
  assert.equal(R.nightsLogged(rows, T), 2);
  assert.equal(R.hasNight(rows, " NOV 1 "), true);
});
