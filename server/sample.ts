// Sample content for phase 1. Dates are worked out from today each time,
// so nothing here is a fixed calendar date. Every response that uses this
// file is marked source: "sample" and the page shows a clear sample note.

import { addDays, lbl, todayStr } from "../shared/dates.js";
import type { Bill, Project, SleepEntry, Task } from "../shared/types.js";

export function sampleData() {
  const t = todayStr();
  const d = (n: number) => addDays(t, n);
  const url = (id: string) => "https://www.notion.so/" + id;

  const projects: Project[] = [
    { id: "p1", url: url("p1"), name: "Sample: Move out", status: "Urgent", next: "Email the landlord about the walkthrough date", focus: true, deadline: d(9) },
    { id: "p2", url: url("p2"), name: "Sample: Spring course", status: "Active", next: "Read the syllabus", focus: false, deadline: d(12) },
    { id: "p3", url: url("p3"), name: "Sample: Home reset", status: "Ongoing", next: "", focus: false, deadline: null },
    { id: "p4", url: url("p4"), name: "Sample: Photo albums", status: "Later", next: "Pick the first album", focus: false, deadline: null },
  ];

  const tasks: Task[] = [
    { id: "t1", url: url("t1"), title: "Sample: Pack the bookshelf", status: "In progress", top3: true, block: "Evening", area: "Home", due: d(0), projectIds: ["p1"] },
    { id: "t2", url: url("t2"), title: "Sample: Call the pharmacy", status: "Not started", top3: true, block: "Lunch", area: "Health", due: null, projectIds: [] },
    { id: "t3", url: url("t3"), title: "Sample: Return library books", status: "Not started", top3: false, block: "After work", area: "Home", due: d(-1), projectIds: [] },
    { id: "t4", url: url("t4"), title: "Sample: Water the plants", status: "Not started", top3: false, block: "Morning", area: "Home", due: d(0), projectIds: ["p3"] },
    { id: "t5", url: url("t5"), title: "Sample: Order course textbook", status: "Not started", top3: false, block: "", area: "Career & learning", due: d(3), projectIds: ["p2"] },
    { id: "t6", url: url("t6"), title: "Sample: Label moving boxes", status: "Not started", top3: false, block: "Evening", area: "Home", due: d(6), projectIds: ["p1"] },
    { id: "t7", url: url("t7"), title: "Sample: Update resume", status: "Not started", top3: false, block: "", area: "Career & learning", due: d(20), projectIds: [] },
    { id: "t8", url: url("t8"), title: "Sample: Sort the junk drawer", status: "Not started", top3: false, block: "", area: "Home", due: null, projectIds: ["p3"] },
  ];

  const bills: Bill[] = [
    { id: "b1", url: url("b1"), name: "Sample: Rent", amount: 1200, type: "Rent", repeats: "Monthly", paid: false, due: d(5) },
    { id: "b2", url: url("b2"), name: "Sample: Electric", amount: 64.5, type: "Utilities", repeats: "Monthly", paid: false, due: d(11) },
    { id: "b3", url: url("b3"), name: "Sample: Domain renewal", amount: 15, type: "Yearly renewal", repeats: "Yearly", paid: false, due: d(40) },
    { id: "b4", url: url("b4"), name: "Sample: Internet", amount: 55, type: "Utilities", repeats: "Monthly", paid: true, due: d(-3) },
  ];

  const at = (n: number, h: number) => new Date(Date.now() + n * 864e5 + h * 36e5).toISOString();
  const sleep: SleepEntry[] = [
    { id: "s1", night: lbl(d(-1)), bed: "1:30 am", wake: "8:15 am", hours: 6.75, logged: at(0, -2) },
    { id: "s2", night: lbl(d(-2)), bed: "12:45 am", wake: "8:00 am", hours: 7.25, logged: at(-1, -2) },
    { id: "s3", night: lbl(d(-3)), bed: "2am", wake: "7:30 am", hours: 5.5, logged: at(-2, -2) },
    { id: "s4", night: lbl(d(-5)), bed: "11pm", wake: "7am", hours: 8, logged: at(-4, -2) },
    { id: "s5", night: lbl(d(-6)), bed: "1am", wake: "8am", hours: 7, logged: at(-5, -2) },
  ];

  return { tasks, projects, bills, sleep };
}
