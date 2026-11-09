// Home Window front end: plain TypeScript, no framework.
// Phase 1: reads sample content from the app's own server. Taps on check
// boxes and forms change only what is on screen and say so.

import "./styles.css";
import { dayNum, addDays, fmtTime, hourNow, hoursBetween, lbl, rel, todayStr, weekday } from "../shared/dates.js";
import type { NoteBlock, ProjectContentResponse, RichBit } from "../shared/types.js";
import type { Bill, CalendarRangeResponse, CalendarResponse, ListResponse, Project, SleepEntry, Source, Task, Calendar } from "../shared/types.js";
import { errText, getJson, postJson } from "./api.js";
import * as R from "./rules.js";
import { CARDS, CATEGORIES, bestByCategory, rateFor } from "./cards.js";

type Status = "loading" | "ok" | "error";
interface Slot<T> { status: Status; data: T | null; err: unknown; source: Source | null }
const slot = <T>(): Slot<T> => ({ status: "loading", data: null, err: null, source: null });

const WEEK_LIMIT = 3;
// A different gentle line each day, chosen by the date so it stays put all day.
const LINES = [
  "One small thing at a time.", "Slow is still moving.", "You are allowed to rest.", "Done is kinder than perfect.",
  "Start small. Small is enough.", "Today can be a soft day.", "One window at a time.", "You don't have to do it all today.",
  "Be gentle with yourself today.", "A little progress still counts.", "It's okay to take the long way.", "Pick one thing. Let the rest wait.",
  "Showing up is the hardest part.", "Notice one good thing today.", "Nothing needs to be finished right now.", "Small steps, steady heart.",
  "Kindness first, lists second.", "You've handled hard days before.", "Ask for help if you need it.", "Good enough is good enough.",
];
const lineFor = (day: string) => LINES[((dayNum(day) % LINES.length) + LINES.length) % LINES.length];
type TimeOfDay = "morning" | "afternoon" | "evening";
const timeOfDay = (h: number): TimeOfDay => (h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : "evening");
const EVENING_FROM = 19; // after this hour, Today shows tomorrow.exe first
const BLOCKS = ["Morning", "Work day", "Lunch", "After work", "Evening"];
const TABS: Array<[string, string]> = [["today", "today"], ["calendar", "calendar"], ["tasks", "tasks"], ["bills", "bills"], ["cards", "cards"], ["projects", "projects"], ["sleep", "sleep"]];

const S = {
  tab: "today",
  tasks: slot<Task[]>(),
  projects: slot<Project[]>(),
  bills: slot<Bill[]>(),
  sleep: slot<SleepEntry[]>(),
  cal: slot<Calendar>(), // today
  calDay: 0, // which day the calendar shows: 0 is today, up to 6 days ahead
  calAhead: {} as Record<number, Slot<Calendar>>, // days after today, loaded when tapped
  range: slot<CalendarRangeResponse>(), // the calendar tab, loaded when opened
  weekOpen: false, // this_week.txt showing everything
  billsGroup: "unpaid" as "unpaid" | "paid", // which bills the bills tab shows
  billForm: false, // the add-a-bill form is open
  confirmPaid: "", // the bill waiting for its second "mark paid" tap
  doneToday: slot<Task[]>(), // tasks finished today, from Notion
  focusProject: "", // a project to scroll to when the projects tab opens
  openProject: "", // the project whose page is open (#project/<id>)
  notes: {} as Record<string, Slot<ProjectContentResponse>>, // project notes, loaded when a page opens
  updated: null as number | null,
  refreshing: false,
  confirmDup: false,
  prevStatus: {} as Record<string, string>, // status a task had before it was marked Done
  doneKeep: {} as Record<string, Task>, // tasks marked done here, kept visible so they can be undone
  busy: {} as Record<string, boolean>, // a change is on its way for this task or form
  draft: { billName: "", billAmount: "", billDue: "", billRepeats: "", billType: "", task: "", block: "", due: "", night: "", bed: "", wake: "", hours: "", hoursTouched: false },
};

const app = document.getElementById("app")!;
const toastEl = document.getElementById("toast")!;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
function money(n: number | null): string {
  return typeof n === "number" ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n) : "";
}
const isSample = () => [S.tasks, S.projects, S.bills, S.sleep, S.cal].some((s) => s.source === "sample");

/* ---------- loading ---------- */
async function load<T>(s: Slot<T>, fn: () => Promise<{ source: Source; data: T }>) {
  s.err = null;
  s.status = s.data ? "ok" : "loading";
  render();
  try {
    const r = await fn();
    s.data = r.data; s.source = r.source; s.status = "ok";
  } catch (e) {
    s.status = "error"; s.err = e; // keep the last good copy in s.data
  }
  render();
}
const list = <T>(path: string) => async () => {
  const r = await getJson<ListResponse<T>>(path);
  if (!Array.isArray(r.items)) throw new Error("bad_shape");
  return { source: r.source, data: r.items };
};

async function loadRange() {
  await load(S.range, async () => { const r = await getJson<CalendarRangeResponse>("/api/calendar/range?days=14"); return { source: r.source, data: r }; });
}

function calSlot(n: number): Slot<Calendar> {
  if (n === 0) return S.cal;
  return (S.calAhead[n] ||= slot<Calendar>());
}
const calFetch = (n: number) => async () => {
  const r = await getJson<CalendarResponse>("/api/calendar?day=" + addDays(todayStr(), n));
  return { source: r.source, data: r.calendar };
};
function pickDay(n: number) {
  if (!Number.isInteger(n) || n < 0 || n > 6) return;
  S.calDay = n;
  const s = calSlot(n);
  if (n !== 0 && (!s.data || s.status === "error")) void load(s, calFetch(n));
  render();
}

async function refreshAll() {
  // Other days reload fresh when tapped again.
  for (const k of Object.keys(S.calAhead)) if (Number(k) !== S.calDay) delete S.calAhead[Number(k)];
  if (S.refreshing) return;
  S.refreshing = true;
  render();
  await Promise.all([
    load(S.tasks, list<Task>("/api/tasks")).then(keepDone),
    load(S.projects, list<Project>("/api/projects")),
    load(S.bills, list<Bill>("/api/bills")),
    load(S.sleep, list<SleepEntry>("/api/sleep")),
    load(S.cal, calFetch(0)),
    load(S.doneToday, list<Task>("/api/tasks/done-today")),
    ...(hourNow() >= EVENING_FROM && S.calDay !== 1 ? [load(calSlot(1), calFetch(1))] : []),
    ...(S.calDay ? [load(calSlot(S.calDay), calFetch(S.calDay))] : []),
  ]);
  if (S.tab === "calendar" || S.range.data) await loadRange();
  if (S.tab === "project" && S.openProject) loadNotes(S.openProject);
  S.updated = Date.now();
  S.refreshing = false;
  render();
}

/* ---------- view helpers ---------- */
function win(title: string, color: string, body: string, wide = false, icon = ""): string {
  return `<section class="win${wide ? " wide" : ""}"><div class="bar ${color}"><span>${icon ? `<svg class="px tiny ${icon}" aria-hidden="true"><use href="#px-${icon}"/></svg>` : ""}${esc(title)}</span><span class="x" aria-hidden="true">×</span></div><div class="body">${body}</div></section>`;
}
function errBlock(e: unknown, server: string) {
  return `<div class="note">${esc(errText(e, server))}</div><div><button class="btn" data-act="refresh">try again</button></div>`;
}
function sect<T>(s: Slot<T>, fn: (d: T) => string, server = "Notion"): string {
  if (!s.data) return s.status === "error" ? errBlock(s.err, server) : '<div class="meta">loading</div>';
  let h = fn(s.data);
  if (s.status === "error") h += `<div class="note">${esc(errText(s.err, server))} Showing the last copy.</div>`;
  return h;
}
function projName(id: string) { return (S.projects.data || []).find((p) => p.id === id)?.name || ""; }

function todo(x: Task): string {
  const t = todayStr(), bits: string[] = [];
  const done = x.status === "Done";
  if (x.block) bits.push(x.block);
  if (x.area) bits.push(x.area);
  const pn = x.projectIds.map(projName).find(Boolean); if (pn) bits.push(pn);
  if (x.due) bits.push(x.due < t ? "was due " + lbl(x.due) : x.due === t ? "due today" : "due " + lbl(x.due));
  return `<div class="todo${done ? " done" : ""}">` +
    `<button class="box" role="checkbox" aria-checked="${done}" aria-label="${done ? "Undo done: " : "Mark done: "}${esc(x.title)}" data-act="toggle" data-id="${esc(x.id)}"${S.busy[x.id] ? " disabled" : ""}></button>` +
    `<div><b>${esc(x.title)}</b><div class="meta">${esc(bits.join(" · "))}</div></div>` +
    `<button class="pin" aria-pressed="${x.top3}" data-act="pin" data-id="${esc(x.id)}"${S.busy[x.id] ? " disabled" : ""}>top 3</button></div>`;
}
function blocksHtml(h: number | null): string {
  const n = Math.max(0, Math.min(8, Math.round(h || 0)));
  let s = ""; for (let i = 0; i < 8; i++) s += `<i class="${i < n ? "on" : ""}"></i>`;
  return `<div class="blocks" role="img" aria-label="${n} of 8 hours">${s}</div>`;
}
function nightSummary(n: SleepEntry | null, withLink: boolean): string {
  if (!n) return '<div class="soft">Last night is not logged yet.</div>' + (withLink ? '<div><a class="btn go" href="#sleep">log it</a></div>' : "");
  return `<div class="big">${esc(n.hours == null ? "logged" : n.hours + " hours")}</div>` + (n.hours == null ? "" : blocksHtml(n.hours)) +
    `<div class="meta">${esc([n.bed && "bed " + n.bed, n.wake && "up " + n.wake].filter(Boolean).join(" · "))}</div>`;
}

/* ---------- views ---------- */
function hello(): string {
  const t = todayStr(), h = hourNow();
  const g = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const up = S.refreshing && !S.updated ? "loading" : S.updated ? "updated " + fmtTime(S.updated) : "";
  // Refresh lives in the greeting's title bar; the "updated" time sits under the greeting.
  const refresh = `<button class="barbtn" type="button" data-act="refresh" aria-label="Refresh from Notion and Google"${S.refreshing ? " disabled" : ""}><span class="spin" aria-hidden="true">↻</span>${S.refreshing ? "refreshing" : "refresh"}</button>`;
  return `<section class="win wide hello"><div class="bar pink"><span>hi, lovely</span>${refresh}</div><div class="body">` +
    `<div class="stack"><div class="date"><svg class="px tiny ${h >= 6 && h < 18 ? "sun" : "moon"}" aria-hidden="true"><use href="#px-${h >= 6 && h < 18 ? "sun" : "moon"}"/></svg>${esc(weekday(t) + " · " + lbl(t))}</div><h1>${g}, <em>Ella.</em></h1>` +
    `<div class="soft">${esc(lineFor(t))}</div>${up ? `<div class="meta">${esc(up)}</div>` : ""}</div><svg class="heart" aria-hidden="true"><use href="#px-heart"/></svg></div></section>` +
    `<nav class="tabs" aria-label="Pages">${TABS.map(([k, name]) => `<a class="tab" href="#${k}"${S.tab === k || (k === "projects" && S.tab === "project") ? ' aria-current="page"' : ""}>${name}</a>`).join("")}</nav>` +
    (isSample() ? '<div class="note sample wide">Sample content. This is not your Notion data yet, and nothing you tap here is saved.</div>' : "");
}

function dayButtons(): string {
  if (!S.cal.data || !S.cal.data.connected) return "";
  const t = todayStr();
  let h = '<div class="days" role="group" aria-label="Choose a day">';
  for (let n = 0; n <= 6; n++) {
    const d = addDays(t, n);
    const name = n === 0 ? "today" : n === 1 ? "tomorrow" : weekday(d).slice(0, 3) + " " + Number(d.slice(8));
    h += `<button class="day" type="button" data-act="day" data-day="${n}" aria-pressed="${S.calDay === n}">${esc(name)}</button>`;
  }
  return h + "</div>";
}

function calBody(c: Calendar, n: number): string {
  if (!c.connected) return '<div class="meta">Work</div><div class="soft">The calendar is not connected yet.</div>' +
    (c.canConnect ? '<div><a class="btn go" href="/api/google/connect">connect calendar</a></div><div class="meta">Read only. It can never change your calendar.</div>' : "");
  const when = n === 0 ? "today" : "that day";
  const d = addDays(todayStr(), n);
  let h = `<div class="meta">${esc(n === 0 ? "Work" : "Work · " + weekday(d) + " " + lbl(d))}</div>`;
  // Hours, or one small italic line. A day off and a day with no shift are the same thing.
  h += c.work ? `<div class="big">${esc(c.work)}</div>` : '<div class="soft">No shift scheduled.</div>';
  const tags = c.tags; // all-day Work events, like payday
  if (tags.length) h += `<div class="row">${tags.map((x) => `<span class="tag butter">${esc(x)}</span>`).join("")}</div>`;
  h += "<hr>";
  h += c.appts.length ? `<ul class="list">${c.appts.map((a) => `<li><span class="meta">${esc(a.time)}</span><span><b>${esc(a.title)}</b></span></li>`).join("")}</ul>` : `<div class="meta">No appointments ${when}</div>`;
  if (c.failed) h += '<div class="note">One calendar did not answer, so this may be missing something.</div>';
  return h;
}

function todayView(): string {
  const t = todayStr(), tasks = S.tasks.data || [];
  const n = S.calDay;
  const cal = win("today.exe", "sky", dayButtons() + sect(calSlot(n), (c) => calBody(c, n), "Google Calendar"));
  const keep = new Set(Object.keys(S.prevStatus));
  const top = R.top3(tasks, keep), due = R.dueToday(tasks, t, keep);
  const topW = win("top_3.txt", "butter", sect(S.tasks, () => top.length ? top.map(todo).join("") : '<div class="soft">No top 3 chosen. Tap "top 3" on up to three tasks.</div>'), false, "star");
  const dueW = win("due_today.txt", "peach", sect(S.tasks, () => due.length ? due.map(todo).join("") : '<div class="soft">Nothing due today.</div>'));
  const sl = win("sleep.log", "lilac", sect(S.sleep, (rows) => nightSummary(R.lastNight(rows, t), true)));

  // coming up, split by kind
  const week = win("this_week.txt", "mint", sect(S.tasks, () => {
    const w = R.weekTasks(tasks, t, keep);
    if (!w.length) return '<div class="soft">No tasks due in the next 7 days.</div>';
    // Keep Today calm: the first few, and the rest only when asked for.
    const shown = S.weekOpen ? w : w.slice(0, WEEK_LIMIT);
    const more = w.length - WEEK_LIMIT;
    return shown.map(todo).join("") + (more > 0
      ? `<div><button class="btn soft" type="button" data-act="week" aria-expanded="${S.weekOpen}">${S.weekOpen ? "show fewer" : "show " + more + " more"}</button></div>`
      : "");
  }), true);
  const dl = win("deadlines.txt", "lilac", sect(S.projects, (rows) => {
    const ps = R.deadlinesSoon(rows, t);
    return ps.length ? `<ul class="list">${ps.map((p) => `<li><span class="meta">${esc(lbl(p.deadline!) + " · " + rel(p.deadline!, t))}</span><span><b>${projLink(p, "plain")}</b></span>${p.next ? `<span>${esc(p.next)}</span>` : ""}</li>`).join("")}</ul>` : '<div class="soft">No deadlines in the next two weeks.</div>';
  }));
  const bl = win("bills_soon.txt", "peach", sect(S.bills, (rows) => {
    const bs = R.billsSoon(rows, t);
    return (bs.length ? `<ul class="list">${bs.map((b) => `<li><div class="line"><span><b>${esc(b.name)}</b></span><span>${esc(money(b.amount))}</span></div><span class="meta">${esc(lbl(b.due!) + " · " + (b.due! < t ? "past its due date" : rel(b.due!, t)))}</span></li>`).join("")}</ul>` : '<div class="soft">No bills due in the next two weeks.</div>');
  }));
  const steps = win("next_steps.txt", "butter", sect(S.projects, (rows) => {
    const ps = R.nextSteps(rows);
    return ps.length ? `<ul class="steps">${ps.map((p) => `<li>${projLink(p, "meta")}${stepLines(p.next)}</li>`).join("")}</ul>` : '<div class="soft">No next steps written for Urgent or Active projects.</div>';
  }), true);
  return eveningWin() + cal + topW + dueW + sl + doneWin() + week + dl + bl + steps + bubble();
}

/** Tasks finished today: from Notion, plus any just ticked here. Only shows once there is one. */
function doneList(): Task[] {
  const seen = new Set<string>(), out: Task[] = [];
  const reopened = new Set((S.tasks.data || []).filter((x) => x.status !== "Done").map((x) => x.id));
  for (const x of [...Object.values(S.doneKeep), ...(S.doneToday.data || [])]) {
    if (seen.has(x.id) || reopened.has(x.id)) continue;
    seen.add(x.id); out.push(x);
  }
  return out;
}
function doneWin(): string {
  const d = doneList();
  if (!d.length) return "";
  const n = d.length;
  return win("done_today.txt", "mint",
    `<div class="mid">${n === 1 ? "One thing done today." : n + " things done today."}</div>` +
    `<ul class="donelist">${d.map((x) => `<li>${esc(x.title)}</li>`).join("")}</ul>` +
    '<div class="soft">That counts. Well done.</div>', true, "star");
}

/** After 7 pm: a calm look at tomorrow. */
function eveningWin(): string {
  if (hourNow() < EVENING_FROM) return "";
  const t = todayStr(), tm = addDays(t, 1);
  const c = calSlot(1);
  let h = `<div class="meta">${esc(weekday(tm) + " · " + lbl(tm))}</div>`;
  if (c.data && c.data.connected) {
    h += c.data.work ? `<div class="mid">${esc("Work " + c.data.work)}</div>` : '<div class="soft">No shift scheduled.</div>';
    if (c.data.tags.length) h += `<div class="row">${c.data.tags.map((x) => `<span class="tag butter">${esc(x)}</span>`).join("")}</div>`;
    if (c.data.appts.length) h += `<ul class="list">${c.data.appts.map((a) => `<li><span class="meta">${esc(a.time)}</span><span><b>${esc(a.title)}</b></span></li>`).join("")}</ul>`;
  } else if (c.status === "loading") h += '<div class="meta">loading</div>';
  const due = (S.tasks.data || []).filter((x) => R.isOpen(x) && x.due === tm).sort(R.byDue);
  if (due.length) h += "<hr>" + `<div class="meta">due tomorrow</div><ul class="donelist plain">${due.slice(0, 3).map((x) => `<li>${esc(x.title)}</li>`).join("")}</ul>` + (due.length > 3 ? `<div class="meta">and ${due.length - 3} more on the tasks tab</div>` : "");
  h += '<div class="soft">That can wait until morning. Rest well.</div>';
  return win("tomorrow.exe", "lilac", h, true, "moon");
}

function bubble(): string {
  const msg = R.startWith(todayStr(), S.tasks.data, S.projects.data);
  return msg ? `<div class="bubble"><span class="meta">start with</span><p>${esc(msg)}</p></div>` : "";
}

function tasksView(): string {
  const d = S.draft, t = todayStr();
  const add = win("add_task.exe", "sky",
    `<form data-form="task"><label for="newTask">Task<input id="newTask" data-draft="task" autocomplete="off" value="${esc(d.task)}"></label>` +
    `<div class="fields"><label for="newBlock">Time block<select id="newBlock" data-draft="block"><option value="">none</option>` +
    BLOCKS.map((b) => `<option${d.block === b ? " selected" : ""}>${b}</option>`).join("") + "</select></label>" +
    `<label for="newDue">Due<input id="newDue" type="date" data-draft="due" value="${esc(d.due)}"></label></div>` +
    `<div><button class="btn" type="submit"${S.busy.add ? " disabled" : ""}>${S.busy.add ? "adding" : "add to Notion"}</button></div></form>`, true);
  if (!S.tasks.data) return add + win("tasks.txt", "butter", sect(S.tasks, () => ""), true);
  const open = S.tasks.data.filter((x) => R.isOpen(x) || S.prevStatus[x.id]);
  const b = R.buckets(open, t);
  const defs: Array<[R.BucketKey, string, string]> = [["overdue", "overdue.txt", "peach"], ["today", "today.txt", "butter"], ["week", "next_7_days.txt", "mint"], ["later", "later.txt", "lilac"], ["none", "no_date.txt", "sky"]];
  const out = defs.filter(([k]) => b[k].length).map(([k, name, color]) => win(name, color, b[k].map(todo).join(""), true)).join("");
  const note = S.tasks.status === "error" ? win("note.txt", "peach", `<div class="note">${esc(errText(S.tasks.err, "Notion"))} Showing the last copy.</div>`, true) : "";
  return add + note + (out || win("all_clear.txt", "mint", '<div class="soft">No open tasks.</div>', true));
}

// Bills are view only. There is deliberately no pay, mark-paid, or edit control here.
// Bills: the owner chose to allow ticking Paid (with a second tap to confirm)
// and adding bills. Nothing here pays, deletes, or edits amounts.
const BILL_COLOR: Record<string, string> = { Rent: "peach", Utilities: "sky", "Yearly renewal": "lilac", Other: "butter" };
function billsView(): string {
  const t = todayStr();
  if (!S.bills.data) return win("bills.txt", "peach", sect(S.bills, () => ""), true);
  const rows = S.bills.data;
  const key = (b: Bill) => b.due || "9999";
  const open = rows.filter((b) => !b.paid).sort((a, b) => key(a).localeCompare(key(b)));
  const paid = rows.filter((b) => b.paid).sort((a, b) => key(b).localeCompare(key(a)));
  const showPaid = S.billsGroup === "paid";
  const sw = '<div class="status"><div class="days" role="group" aria-label="Which bills to show">' +
    `<button class="day" type="button" data-act="billsview" data-v="unpaid" aria-pressed="${!showPaid}">unpaid (${open.length})</button>` +
    `<button class="day" type="button" data-act="billsview" data-v="paid" aria-pressed="${showPaid}">paid (${paid.length})</button>` +
    '</div><span class="meta">marking paid only ticks the box in Notion</span></div>';
  const note = S.bills.status === "error" ? `<div class="note wide">${esc(errText(S.bills.err, "Notion"))} Showing the last copy.</div>` : "";
  const list = showPaid ? paid : open;
  const d = S.draft;
  const opt = (vals: string[], cur: string) => '<option value="">none</option>' + vals.map((v) => `<option${cur === v ? " selected" : ""}>${v}</option>`).join("");
  const form = S.billForm ? win("add_a_bill.exe", "sky",
    '<form data-form="bill">' +
    `<label for="billName">Bill<input id="billName" data-draft="billName" autocomplete="off" maxlength="120" value="${esc(d.billName)}"></label>` +
    '<div class="fields">' +
    `<label for="billAmount">Amount ($)<input id="billAmount" data-draft="billAmount" inputmode="decimal" autocomplete="off" value="${esc(d.billAmount)}"></label>` +
    `<label for="billDue">Due<input id="billDue" type="date" data-draft="billDue" value="${esc(d.billDue)}"></label>` +
    `<label for="billRepeats">Repeats<select id="billRepeats" data-draft="billRepeats">${opt(["Monthly", "Yearly", "One-time"], d.billRepeats)}</select></label>` +
    `<label for="billType">Type<select id="billType" data-draft="billType">${opt(["Rent", "Utilities", "Other", "Yearly renewal"], d.billType)}</select></label>` +
    "</div>" +
    '<div class="meta">Adds a new bill to Notion. It does not pay or mark anything paid.</div>' +
    `<div class="row"><button class="btn" type="submit"${S.busy.bill ? " disabled" : ""}>${S.busy.bill ? "adding" : "add to Notion"}</button><button class="btn soft" type="button" data-act="billform">close</button></div>` +
    "</form>", true) : "";
  const addBtn = S.billForm ? "" : '<div class="status"><button class="btn add" type="button" data-act="billform">add a bill</button></div>';
  if (!list.length) return addBtn + form + sw + note + win("bills.txt", "mint", `<div class="soft">${showPaid ? "No bills marked paid." : "No unpaid bills listed."}</div>`, true);
  return addBtn + form + sw + note + list.map((b) => {
    const when = b.due ? (showPaid ? lbl(b.due) : b.due < t ? lbl(b.due) + " · past its due date" : lbl(b.due) + " · due " + rel(b.due, t)) : "no date";
    const tags = [b.type, b.repeats].filter(Boolean).map((x) => `<span class="tag">${esc(x.toLowerCase())}</span>`).join("") + (showPaid ? '<span class="tag mint">paid</span>' : "");
    const busy = !!S.busy["bill" + b.id];
    const action = showPaid
      ? `<button class="btn soft" type="button" data-act="unpaid" data-id="${esc(b.id)}"${busy ? " disabled" : ""}>move back to unpaid</button>`
      : `<button class="btn pay${S.confirmPaid === b.id ? " confirm" : ""}" type="button" data-act="paid" data-id="${esc(b.id)}"${busy ? " disabled" : ""}>${S.confirmPaid === b.id ? "tap again to confirm" : "mark paid"}</button>`;
    const body = `<div class="line"><span class="mid">${esc(b.name)}</span><span class="mid">${esc(money(b.amount))}</span></div>` +
      `<div class="meta">${esc(when)}</div>` + (tags ? `<div class="row">${tags}</div>` : "") +
      `<div class="row">${action}</div>`;
    return win(fileName(b.name), showPaid ? "mint" : BILL_COLOR[b.type] || "butter", body);
  }).join("");
}

const STATUS_ORDER = ["Urgent", "Active", "Ongoing", "Later"];
const STATUS_COLOR: Record<string, string> = { Urgent: "peach", Active: "butter", Ongoing: "mint", Later: "lilac" };
/** "Move out!" -> "move_out.txt", like the other window names. */
/** A project's name that opens its window on the projects tab. */
function projLink(p: Project, cls: string): string {
  return `<a class="${cls} golink" href="#project/${esc(p.id)}">${esc(p.name)}</a>`;
}
function goProject(id: string) {
  S.focusProject = id;
  if (location.hash !== "#projects") location.hash = "#projects";
  else { route(); scrollToProject(); }
}

/** A Next step with several lines shows each line as its own step. */
function stepLines(next: string): string {
  const lines = next.split(/\r?\n+/).map((x) => x.replace(/^\s*([-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean);
  if (lines.length <= 1) return `<div class="step">${esc(lines[0] || next)}</div>`;
  return lines.map((x) => `<div class="step">${esc(x)}</div>`).join("");
}

function fileName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 28);
  return (slug || "project") + ".txt";
}

// One window per project, most urgent first, then by deadline, then by name.
function projectsView(): string {
  if (!S.projects.data) return win("projects.txt", "butter", sect(S.projects, () => ""), true);
  const open = (S.tasks.data || []).filter(R.isOpen);
  const rank = (p: Project) => { const i = STATUS_ORDER.indexOf(p.status); return i < 0 ? STATUS_ORDER.length : i; };
  const rows = S.projects.data.slice().sort((a, b) =>
    rank(a) - rank(b) || (a.deadline || "9999").localeCompare(b.deadline || "9999") || a.name.localeCompare(b.name));
  const note = S.projects.status === "error" ? `<div class="note wide">${esc(errText(S.projects.err, "Notion"))} Showing the last copy.</div>` : "";
  if (!rows.length) return note + win("projects.txt", "butter", '<div class="soft">No projects yet.</div>', true);
  return note + rows.map((p) => {
    const n = open.filter((x) => x.projectIds.includes(p.id)).length;
    const color = STATUS_COLOR[p.status] || "sky";
    const tags = (p.status ? `<span class="tag ${color}">${esc(p.status.toLowerCase())}</span>` : "") +
      (p.focus ? '<span class="tag butter">focus</span>' : "") +
      (p.deadline ? `<span class="tag">${esc("deadline " + lbl(p.deadline))}</span>` : "") +
      (n ? `<span class="tag">${n} open</span>` : "");
    const body = `<div class="mid"><a class="plain golink" href="#project/${esc(p.id)}">${esc(p.name)}</a></div>` +
      (tags ? `<div class="row">${tags}</div>` : "") +
      (p.next ? `<div class="stack tight"><span class="meta">next step</span>${stepLines(p.next)}</div>` : '<div class="meta">no next step written</div>') +
      `<div class="row"><a class="btn go" href="#project/${esc(p.id)}">open</a><a class="link" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">open in Notion</a></div>`;
    return win(fileName(p.name), color, body).replace('<section class="win"', `<section class="win" id="p-${esc(p.id)}"`);
  }).join("");
}

function sleepView(): string {
  const t = todayStr(), d = S.draft;
  if (!d.night) d.night = lbl(addDays(t, -1));
  const rows = S.sleep.data || [];
  const dup = R.hasNight(rows, d.night);
  const form = win("log_a_night.exe", "sky",
    '<form data-form="sleep"><div class="fields">' +
    `<label for="slNight">Night of<input id="slNight" data-draft="night" autocomplete="off" value="${esc(d.night)}"></label>` +
    `<label for="slBed">Bedtime<input id="slBed" data-draft="bed" autocomplete="off" placeholder="like 3:45 am" value="${esc(d.bed)}"></label>` +
    `<label for="slWake">Wake-up<input id="slWake" data-draft="wake" autocomplete="off" placeholder="like 9:45 am" value="${esc(d.wake)}"></label>` +
    `<label for="slHours">Hours slept<input id="slHours" data-draft="hours" inputmode="decimal" autocomplete="off" value="${esc(d.hours)}"></label></div>` +
    '<div class="meta">Hours fill in from bedtime and wake-up. You can change them.</div>' +
    (dup && S.confirmDup ? `<div class="note">There is already an entry for ${esc(d.night)}. The newest one counts. Tap again to save another.</div>` : "") +
    `<div><button class="btn" type="submit"${S.busy.sleep ? " disabled" : ""}>${S.busy.sleep ? "saving" : dup && S.confirmDup ? "save another entry" : "save to Notion"}</button></div></form>`);
  const last = win("last_night.log", "lilac", '<svg class="px cat" role="img" aria-label="a sleeping pixel cat"><use href="#px-cat"/></svg>' + sect(S.sleep, (r) => nightSummary(R.lastNight(r, t), false)));
  const wk = win("this_week.txt", "mint", sect(S.sleep, (r) => {
    const latest = R.latestPerNight(r);
    const nights: string[] = []; for (let i = 1; i <= 7; i++) nights.push(lbl(addDays(t, -i)));
    return `<div class="soft">${R.nightsLogged(r, t)} of the last 7 nights logged.</div><ul class="list">` + nights.map((lab) => {
      const e = latest.find((x) => x.night.trim().toLowerCase() === lab.toLowerCase());
      return `<li><div class="line"><span><b>${esc(lab)}</b></span><span>${esc(!e ? "not logged" : e.hours == null ? "logged" : e.hours + " h")}</span></div>${e && e.hours != null ? blocksHtml(e.hours) : ""}</li>`;
    }).join("") + "</ul>";
  }), true);
  return last + form + wk;
}

const DAY_COLORS = ["sky", "mint", "lilac", "butter", "peach", "pink"];
function calendarView(): string {
  const t = todayStr();
  const r = S.range;
  if (!r.data) return win("calendar.txt", "sky", sect(r, () => "", "Google Calendar"), true);
  const d = r.data;
  const note = r.status === "error" ? `<div class="note wide">${esc(errText(r.err, "Google Calendar"))} Showing the last copy.</div>` : "";
  if (!d.connected) {
    return win("calendar.txt", "sky", '<div class="soft">The calendar is not connected yet.</div>' +
      (d.canConnect ? '<div><a class="btn go" href="/api/google/connect">connect calendar</a></div><div class="meta">Read only. It can never change your calendar.</div>' : ""), true);
  }
  const intro = '<div class="status"><a class="btn go" href="https://calendar.google.com/calendar/r" target="_blank" rel="noopener noreferrer">open Google Calendar</a><span class="meta">the next two weeks</span></div>';
  const days = d.days.map(({ day, calendar: c }, i) => {
    if (!c.connected) return "";
    const name = (weekday(day).slice(0, 3) + "_" + lbl(day).replace(" ", "_")).toLowerCase() + ".txt";
    let h = `<div class="row"><span class="meta">${esc(weekday(day) + " · " + lbl(day))}</span>${day === t ? '<span class="tag butter">today</span>' : ""}</div>`;
    h += c.work ? `<div class="mid">${esc("Work " + c.work)}</div>` : '<div class="soft">No shift scheduled.</div>';
    if (c.tags.length) h += `<div class="row">${c.tags.map((x) => `<span class="tag butter">${esc(x)}</span>`).join("")}</div>`;
    h += c.appts.length
      ? `<ul class="list">${c.appts.map((a) => `<li><span class="meta">${esc(a.time)}</span><span>${a.link ? `<a class="plain" href="${esc(a.link)}" target="_blank" rel="noopener noreferrer"><b>${esc(a.title)}</b></a>` : `<b>${esc(a.title)}</b>`}</span></li>`).join("")}</ul>`
      : `<div class="meta">No appointments</div>`;
    const [y, m, dd] = day.split("-").map(Number);
    h += `<div><a class="link" href="https://calendar.google.com/calendar/r/day/${y}/${m}/${dd}" target="_blank" rel="noopener noreferrer">open in Google Calendar</a></div>`;
    return win(name, DAY_COLORS[i % DAY_COLORS.length], h);
  }).join("");
  const failed = d.days.some((x) => x.calendar.connected && x.calendar.failed) ? '<div class="note wide">One calendar did not answer, so this may be missing something.</div>' : "";
  return intro + note + failed + days;
}

function richHtml(bits: RichBit[]): string {
  return bits.map((r) => {
    let h = esc(r.t);
    if (r.c) h = `<code>${h}</code>`;
    if (r.b) h = `<b>${h}</b>`;
    if (r.i) h = `<i>${h}</i>`;
    if (r.s) h = `<s>${h}</s>`;
    if (r.href) h = `<a class="golink" href="${esc(r.href)}" target="_blank" rel="noopener noreferrer">${h}</a>`;
    return h;
  }).join("");
}
function notesHtml(blocks: NoteBlock[]): string {
  let n = 0;
  return blocks.map((b) => {
    n = b.kind === "ol" ? n + 1 : 0;
    const t = richHtml(b.text), more = b.more ? '<span class="meta"> · more in Notion</span>' : "";
    switch (b.kind) {
      case "h1": return `<div class="nh1">${t}${more}</div>`;
      case "h2": return `<div class="nh2">${t}${more}</div>`;
      case "h3": return `<div class="nh3">${t}${more}</div>`;
      case "li": return `<div class="nli">${t}${more}</div>`;
      case "ol": return `<div class="nol"><span class="num">${n}.</span> ${t}${more}</div>`;
      case "todo": return `<div class="ntodo${b.checked ? " on" : ""}"><span class="mini" aria-label="${b.checked ? "done" : "not done"}"></span><span>${t}</span>${more}</div>`;
      case "quote": return `<div class="nquote">${t}${more}</div>`;
      case "callout": return `<div class="note">${t}${more}</div>`;
      case "toggle": return `<div class="nli">${t}<span class="meta"> · more in Notion</span></div>`;
      case "code": return `<pre class="ncode">${t}</pre>`;
      case "divider": return "<hr>";
      case "p": return t ? `<div>${t}${more}</div>` : "";
      case "link": return `<div>${t}</div>`;
      default: return `<div class="meta">${t}</div>`;
    }
  }).join("") || '<div class="soft">No notes on this page yet.</div>';
}

function projectPageView(): string {
  const id = S.openProject;
  const back = `<div class="status"><a class="btn go back" href="#projects" data-act="backprojects" data-id="${esc(id)}">all projects</a></div>`;
  if (!S.projects.data) return back + win("project.txt", "butter", sect(S.projects, () => ""), true);
  const p = S.projects.data.find((x) => x.id === id);
  if (!p) return back + win("project.txt", "butter", '<div class="soft">That project was not found. It may have been renamed or moved in Notion.</div>', true);
  const color = STATUS_COLOR[p.status] || "sky";
  const t = todayStr();
  const keep = new Set(Object.keys(S.prevStatus));
  const tasks = (S.tasks.data || []).filter((x) => x.projectIds.includes(p.id) && (R.isOpen(x) || keep.has(x.id))).sort(R.byDue);
  const tags = (p.status ? `<span class="tag ${color}">${esc(p.status.toLowerCase())}</span>` : "") +
    (p.focus ? '<span class="tag butter">focus</span>' : "") +
    (p.deadline ? `<span class="tag">${esc("deadline " + lbl(p.deadline) + " · " + rel(p.deadline, t))}</span>` : "");
  const head = win(fileName(p.name), color,
    `<div class="big">${esc(p.name)}</div>` + (tags ? `<div class="row">${tags}</div>` : "") +
    (p.next ? `<div class="stack tight"><span class="meta">next step</span>${stepLines(p.next)}</div>` : '<div class="meta">no next step written</div>') +
    `<div><a class="link" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">open in Notion</a></div>`, true);
  const taskW = win("tasks.txt", "sky", sect(S.tasks, () => tasks.length ? tasks.map(todo).join("") : '<div class="soft">No open tasks for this project.</div>'), true);
  const ns = S.notes[p.id] || slot<ProjectContentResponse>();
  let notesW: string;
  if (!ns.data) {
    notesW = win("notes.txt", "mint", sect(ns, () => ""), true);
  } else {
    // Each heading starts its own window; anything before the first heading goes in notes.txt.
    const r = ns.data;
    const groups: Array<{ title: string; blocks: NoteBlock[] }> = [];
    for (const b of r.blocks) {
      if (b.kind === "h1" || b.kind === "h2" || b.kind === "h3") {
        groups.push({ title: b.text.map((x) => x.t).join("").trim() || "notes", blocks: b.more ? [{ kind: "other", text: [{ t: "More under this heading in Notion" }] }] : [] });
      } else {
        if (!groups.length) groups.push({ title: "", blocks: [] });
        groups[groups.length - 1].blocks.push(b);
      }
    }
    for (const g of groups) { // a dividing line at the edge of a window looks stray
      while (g.blocks[0]?.kind === "divider") g.blocks.shift();
      while (g.blocks[g.blocks.length - 1]?.kind === "divider") g.blocks.pop();
    }
    const colors = ["mint", "lilac", "peach", "butter", "sky", "pink"];
    const errNote = ns.status === "error" ? `<div class="note">${esc(errText(ns.err, "Notion"))} Showing the last copy.</div>` : "";
    notesW = groups.length
      ? groups.map((g, i) => win(g.title ? fileName(g.title) : "notes.txt", colors[i % colors.length],
          (g.title ? `<div class="mid">${esc(g.title)}</div>` : "") +
          '<div class="notes">' + (g.blocks.length ? notesHtml(g.blocks) : '<div class="soft">Nothing under this heading yet.</div>') + "</div>" +
          (i === 0 ? errNote : ""), true)).join("")
      : win("notes.txt", "mint", '<div class="soft">No notes on this page yet.</div>' + errNote, true);
    notesW = '<div class="meta wide">notes are read only here · edit them in Notion</div>' + notesW +
      (r.truncated ? '<div class="note wide">This page is long, so only the first part shows here. The rest is in Notion.</div>' : "");
  }
  return back + head + taskW + notesW;
}

function loadNotes(id: string) {
  const s = (S.notes[id] ||= slot<ProjectContentResponse>());
  void load(s, async () => { const r = await getJson<ProjectContentResponse>("/api/projects/" + encodeURIComponent(id) + "/content"); return { source: r.source, data: r }; });
}

// A reference page only: no data is loaded, and nothing here is saved anywhere.
function cardsView(): string {
  const pct = (n: number) => (Number.isInteger(n) ? n : n.toFixed(1)) + "%";
  const best = bestByCategory();
  const intro = '<div class="status"><span class="meta">which card earns the most · rates can change, so check each card\'s page</span></div>';
  const bestW = win("best_card_for.txt", "butter",
    `<ul class="list">${best.map((b) => `<li><div class="line"><span><b>${esc(b.cat)}</b></span><span class="mid">${pct(b.rate)}</span></div><span class="row">${b.cards.map((c) => `<span class="tag ${c.color}">${esc(c.name)}</span>`).join("")}</span></li>`).join("")}</ul>`, true, "star");
  const cardWins = CARDS.map((c) => {
    const rows = c.rates.map((r) => `<li><div class="line"><span>${esc(r.cat)}</span><span><b>${pct(r.rate)}</b></span></div>${r.note ? `<span class="meta">${esc(r.note)}</span>` : ""}</li>`).join("");
    return win(fileName(c.name), c.color,
      `<div class="line"><span class="mid">${esc(c.name)}</span><span class="mid">${pct(c.base)}</span></div>` +
      '<div class="meta">everything else</div>' +
      (rows ? `<ul class="list">${rows}</ul>` : "") +
      c.notes.filter((n) => !/^Everything else/.test(n)).map((n) => `<div class="soft">${esc(n)}</div>`).join("") +
      `<div><a class="link" href="${esc(c.link)}" target="_blank" rel="noopener noreferrer">check current rates</a></div>`);
  }).join("");
  const grid = win("side_by_side.txt", "lilac",
    `<div class="tablewrap"><table class="rates"><thead><tr><th>category</th>${CARDS.map((c) => `<th>${esc(c.name.replace(/^(Capital One|Chase|Fidelity Rewards) /, ""))}</th>`).join("")}</tr></thead><tbody>` +
    CATEGORIES.map((cat) => {
      const top = Math.max(...CARDS.map((c) => rateFor(c, cat)));
      return `<tr><td>${esc(cat)}</td>${CARDS.map((c) => { const r = rateFor(c, cat); return `<td${r === top ? ' class="top"' : ""}>${pct(r)}</td>`; }).join("")}</tr>`;
    }).join("") + "</tbody></table></div>", true);
  return intro + bestW + cardWins + grid;
}

function view(): string {
  const v = S.tab === "cards" ? cardsView() : S.tab === "project" ? projectPageView() : S.tab === "calendar" ? calendarView() : S.tab === "tasks" ? tasksView() : S.tab === "bills" ? billsView() : S.tab === "projects" ? projectsView() : S.tab === "sleep" ? sleepView() : todayView();
  return hello() + v + '<div class="foot">thank you for showing up today</div>';
}

/** A tiny pixel sparkle where a task was ticked. It lives outside the page, so redraws don't replay it. */
function sparkle(el: Element) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const r = el.getBoundingClientRect();
  const sp = document.createElement("div");
  sp.className = "spark";
  sp.setAttribute("aria-hidden", "true");
  sp.style.left = r.left + r.width / 2 + "px";
  sp.style.top = r.top + r.height / 2 + "px";
  document.body.appendChild(sp);
  setTimeout(() => sp.remove(), 700);
}

function render() {
  document.documentElement.dataset.time = timeOfDay(hourNow());
  const a = document.activeElement as HTMLInputElement | null;
  const id = a?.id, ss = a?.selectionStart, se = a?.selectionEnd;
  app.innerHTML = view();
  if (id) {
    const n = document.getElementById(id) as HTMLInputElement | null;
    if (n) { try { n.focus({ preventScroll: true }); if (ss != null && se != null && n.setSelectionRange) n.setSelectionRange(ss, se); } catch { /* not a text field */ } }
  }
}

function toast(msg: string, bad = false) {
  toastEl.textContent = msg;
  toastEl.className = "toast" + (bad ? " bad" : "");
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4500);
}

/* ---------- actions ---------- */
// Each of these starts from a tap; nothing writes on load. With sample
// content they change only the screen. With live data they send one change
// to the server, never retry on their own, and then re-read from Notion.
const SAMPLE_NOTE = "Sample only. Nothing was saved to Notion.";
const find = (id: string) => (S.tasks.data || []).find((x) => x.id === id);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isLive = (s: Slot<unknown>) => s.source === "live";
function writeMsg(e: unknown): string {
  const m = errText(e, "Notion");
  return /Nothing was|Refresh to check/.test(m) ? m : m + " Nothing was changed.";
}

async function reloadTasks() {
  await pause(700); // give Notion a moment so the re-read includes the change
  await load(S.tasks, list<Task>("/api/tasks"));
  keepDone();
}
/** Tasks marked done here stay on screen (crossed out) so they can be undone. */
function keepDone() {
  if (!S.tasks.data) return;
  for (const [id, t] of Object.entries(S.doneKeep)) {
    if (!S.tasks.data.some((x) => x.id === id)) S.tasks.data.push({ ...t, status: "Done" });
  }
  render();
}

async function toggleDone(id: string) {
  const x = find(id); if (!x || S.busy[id]) return;
  const wasDone = x.status === "Done";
  const before = x.status;
  const next = wasDone ? S.prevStatus[id] || "Not started" : "Done";
  if (!isLive(S.tasks)) {
    if (wasDone) { delete S.prevStatus[id]; delete S.doneKeep[id]; } else { S.prevStatus[id] = before; S.doneKeep[id] = { ...x, status: "Done" }; }
    x.status = next; render(); toast(SAMPLE_NOTE); return;
  }
  S.busy[id] = true; x.status = next; render();
  try {
    await postJson("/api/tasks/" + encodeURIComponent(id) + "/status", { status: next });
    if (wasDone) { delete S.prevStatus[id]; delete S.doneKeep[id]; }
    else { S.prevStatus[id] = before; S.doneKeep[id] = { ...x }; }
    toast(wasDone ? "Moved back onto your list." : "Marked done in Notion.");
    S.busy[id] = false;
    await reloadTasks();
    void load(S.doneToday, list<Task>("/api/tasks/done-today"));
  } catch (e) {
    x.status = before; S.busy[id] = false; render(); toast(writeMsg(e), true);
  }
}

async function togglePin(id: string) {
  const x = find(id); if (!x || S.busy[id]) return;
  const next = !x.top3;
  if (!isLive(S.tasks)) { x.top3 = next; render(); toast(SAMPLE_NOTE); return; }
  S.busy[id] = true; x.top3 = next; render();
  try {
    await postJson("/api/tasks/" + encodeURIComponent(id) + "/top3", { top3: next });
    if (S.doneKeep[id]) S.doneKeep[id].top3 = next;
    toast(next ? "Added to your top 3." : "Removed from your top 3.");
    S.busy[id] = false;
    await reloadTasks();
  } catch (e) {
    x.top3 = !next; S.busy[id] = false; render(); toast(writeMsg(e), true);
  }
}

async function addTask() {
  const d = S.draft, title = d.task.trim();
  if (S.busy.add) return;
  if (!title) { toast("Type a task first.", true); return; }
  if (!S.tasks.data) { toast("Tasks are not loaded yet. Tap refresh, then try again.", true); return; }
  if (!isLive(S.tasks)) {
    S.tasks.data.push({ id: "local-" + Date.now(), url: "", title, status: "Not started", top3: false, block: d.block, area: "", due: d.due || null, projectIds: [] });
    d.task = ""; d.block = ""; d.due = ""; render(); toast(SAMPLE_NOTE); return;
  }
  S.busy.add = true; render();
  try {
    await postJson("/api/tasks", { title, block: d.block, due: d.due || null });
    d.task = ""; d.block = ""; d.due = "";
    S.busy.add = false; toast("Added to Notion.");
    await reloadTasks();
  } catch (e) {
    S.busy.add = false; render(); toast(writeMsg(e).replace("Nothing was changed.", "Nothing was added."), true);
  }
}

let confirmTimer: ReturnType<typeof setTimeout> | undefined;
async function setPaid(id: string, paid: boolean) {
  const x = (S.bills.data || []).find((b) => b.id === id);
  if (!x || S.busy["bill" + id]) return;
  if (paid && S.confirmPaid !== id) {
    // First tap only asks. The second tap, within a few seconds, marks it.
    S.confirmPaid = id; render();
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => { if (S.confirmPaid === id) { S.confirmPaid = ""; render(); } }, 5000);
    return;
  }
  S.confirmPaid = ""; clearTimeout(confirmTimer);
  if (!isLive(S.bills)) { x.paid = paid; render(); toast(SAMPLE_NOTE); return; }
  S.busy["bill" + id] = true; x.paid = paid; render();
  try {
    await postJson("/api/bills/" + encodeURIComponent(id) + "/paid", { paid });
    S.busy["bill" + id] = false;
    toast(paid ? "Marked paid in Notion." : "Moved back to unpaid in Notion.");
    await pause(700);
    await load(S.bills, list<Bill>("/api/bills"));
  } catch (e) {
    x.paid = !paid; S.busy["bill" + id] = false; render(); toast(writeMsg(e), true);
  }
}

async function addBill() {
  const d = S.draft, name = d.billName.trim();
  if (S.busy.bill) return;
  if (!name) { toast("Type the bill's name first.", true); return; }
  const amt = d.billAmount.trim() === "" ? null : Number(d.billAmount.replace(/[$,\s]/g, ""));
  if (amt !== null && (!isFinite(amt) || amt < 0)) { toast("The amount should be a number, like 64.50.", true); return; }
  if (!S.bills.data) { toast("Bills are not loaded yet. Tap refresh, then try again.", true); return; }
  const clear = () => { d.billName = ""; d.billAmount = ""; d.billDue = ""; d.billRepeats = ""; d.billType = ""; };
  if (!isLive(S.bills)) {
    S.bills.data.push({ id: "local-" + Date.now(), url: "", name, amount: amt, type: d.billType, repeats: d.billRepeats, paid: false, due: d.billDue || null });
    clear(); S.billForm = false; S.billsGroup = "unpaid"; render(); toast(SAMPLE_NOTE); return;
  }
  S.busy.bill = true; render();
  try {
    await postJson("/api/bills", { name, amount: amt, due: d.billDue || null, repeats: d.billRepeats, type: d.billType });
    clear(); S.busy.bill = false; S.billForm = false; S.billsGroup = "unpaid"; toast("Bill added to Notion.");
    await pause(700);
    await load(S.bills, list<Bill>("/api/bills"));
  } catch (e) {
    S.busy.bill = false; render(); toast(writeMsg(e).replace("Nothing was changed.", "Nothing was added."), true);
  }
}

async function saveSleep() {
  const d = S.draft, night = d.night.trim(), hrs = parseFloat(d.hours);
  if (S.busy.sleep) return;
  if (!night || isNaN(hrs) || hrs < 0 || hrs > 24) { toast("Add the night and the hours slept (0 to 24).", true); return; }
  if (!S.sleep.data) { toast("Sleep is not loaded yet. Tap refresh, then try again.", true); return; }
  if (R.hasNight(S.sleep.data, night) && !S.confirmDup) { S.confirmDup = true; render(); return; }
  const entry = { night, bed: d.bed.trim(), wake: d.wake.trim(), hours: hrs };
  const clear = () => { d.night = ""; d.bed = ""; d.wake = ""; d.hours = ""; d.hoursTouched = false; S.confirmDup = false; };
  if (!isLive(S.sleep)) {
    S.sleep.data.push({ id: "local-" + Date.now(), ...entry, logged: new Date().toISOString() });
    clear(); render(); toast(SAMPLE_NOTE); return;
  }
  S.busy.sleep = true; render();
  try {
    await postJson("/api/sleep", entry);
    clear(); S.busy.sleep = false; toast("Sleep saved to Notion.");
    await pause(700);
    await load(S.sleep, list<SleepEntry>("/api/sleep"));
  } catch (e) {
    S.busy.sleep = false; render(); toast(writeMsg(e).replace("Nothing was changed.", "Nothing was saved."), true);
  }
}

/* ---------- events ---------- */
app.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]"); if (!b) return;
  const a = b.dataset.act, id = b.dataset.id || "";
  if (a === "refresh") void refreshAll();
  else if (a === "day") pickDay(Number(b.dataset.day));
  else if (a === "week") { S.weekOpen = !S.weekOpen; render(); }
  else if (a === "paid") void setPaid(id, true);
  else if (a === "unpaid") void setPaid(id, false);
  else if (a === "billform") { S.billForm = !S.billForm; render(); if (S.billForm) document.getElementById("billName")?.focus(); }
  else if (a === "billsview") { S.billsGroup = b.dataset.v === "paid" ? "paid" : "unpaid"; render(); }
  else if (a === "goproject") { e.preventDefault(); goProject(id); }
  else if (a === "backprojects") { e.preventDefault(); goProject(id); }
  else if (a === "toggle") { if (find(id)?.status !== "Done") sparkle(b); void toggleDone(id); }
  else if (a === "pin") void togglePin(id);
});
app.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement, k = t.dataset?.draft as keyof typeof S.draft | undefined;
  if (!k || k === "hoursTouched") return;
  S.draft[k] = t.value;
  if (k === "hours") S.draft.hoursTouched = true;
  if (k === "night") S.confirmDup = false;
  if ((k === "bed" || k === "wake") && !S.draft.hoursTouched) {
    const h = hoursBetween(S.draft.bed, S.draft.wake);
    const el = document.getElementById("slHours") as HTMLInputElement | null;
    if (h != null) { S.draft.hours = String(h); if (el) el.value = String(h); }
  }
});
app.addEventListener("change", (e) => {
  const t = e.target as HTMLSelectElement;
  if (t.tagName === "SELECT" && t.dataset.draft === "block") S.draft.block = t.value;
});
app.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = (e.target as HTMLFormElement).dataset.form;
  if (f === "task") void addTask(); else if (f === "sleep") void saveSleep(); else if (f === "bill") void addBill();
});

function route() {
  const h = location.hash.replace("#", "");
  const pm = h.match(/^project\/([0-9a-z]{1,64})$/i);
  if (pm) {
    S.tab = "project"; S.openProject = pm[1];
    if (S.updated) loadNotes(pm[1]); // fresh notes each time a page opens
  } else {
    S.tab = TABS.some(([k]) => k === h) ? h : "today";
  }
  if (S.tab === "calendar" && !S.range.data && S.range.status !== "error" && S.updated) void loadRange();
  render();
}
window.addEventListener("hashchange", () => { route(); if (!scrollToProject()) window.scrollTo(0, 0); });
function scrollToProject(): boolean {
  const id = S.focusProject; S.focusProject = "";
  if (!id || S.tab !== "projects") return false;
  const el = document.getElementById("p-" + id);
  if (!el) return false;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  el.classList.add("glow");
  setTimeout(() => el.classList.remove("glow"), 1600);
  return true;
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && S.updated && Date.now() - S.updated > 5 * 60e3) void refreshAll();
});

route();
void refreshAll();
