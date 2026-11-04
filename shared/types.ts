// Shapes the server sends to the browser. The server turns Notion and
// Google responses into these, so the browser never sees raw API data.

export type Source = "sample" | "live";

export interface Task {
  id: string;
  url: string;
  title: string;
  status: string; // Not started, In progress, Done
  top3: boolean;
  block: string;
  area: string;
  due: string | null; // YYYY-MM-DD
  projectIds: string[];
}

export interface Project {
  id: string;
  url: string;
  name: string;
  status: string; // Urgent, Active, Ongoing, Later
  next: string;
  focus: boolean;
  deadline: string | null;
}

export interface Bill {
  id: string;
  url: string;
  name: string;
  amount: number | null;
  type: string;
  repeats: string;
  paid: boolean;
  due: string | null;
}

export interface SleepEntry {
  id: string;
  night: string; // "Nov 3"
  bed: string;
  wake: string;
  hours: number | null;
  logged: string; // ISO time the row was created
}

export interface Appointment {
  sort: string;
  time: string;
  title: string;
  link?: string; // the event in Google Calendar, for editing there
}

export type Calendar =
  | { connected: false; canConnect?: boolean }
  | { connected: true; work: string | null; noWork: string[]; tags: string[]; appts: Appointment[]; failed: number };

export interface ListResponse<T> {
  source: Source;
  items: T[];
}

export interface CalendarDay { day: string; calendar: Calendar }
export interface CalendarRangeResponse { source: Source; days: CalendarDay[]; connected: boolean; canConnect?: boolean }

export interface CalendarResponse {
  source: Source;
  calendar: Calendar;
}

export interface ApiError {
  error: { code: string; message: string };
}
