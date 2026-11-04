import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, hoursBetween, lbl, parseClock, rel } from "../shared/dates.js";

test("parseClock accepts the formats the Sleep Log uses", () => {
  assert.equal(parseClock("3:45 am"), 3 * 60 + 45);
  assert.equal(parseClock("3:45 AM"), 3 * 60 + 45);
  assert.equal(parseClock("4am"), 240);
  assert.equal(parseClock("11pm"), 23 * 60);
  assert.equal(parseClock("23:30"), 23 * 60 + 30);
  assert.equal(parseClock("12am"), 0);
  assert.equal(parseClock("12pm"), 720);
  assert.equal(parseClock("4 a.m."), 240);
  assert.equal(parseClock("25:00"), null);
  assert.equal(parseClock("13pm"), null);
  assert.equal(parseClock("soon"), null);
});

test("hoursBetween wraps past midnight and rounds to a quarter hour", () => {
  assert.equal(hoursBetween("11pm", "7am"), 8);
  assert.equal(hoursBetween("3:45 am", "9:45 am"), 6);
  assert.equal(hoursBetween("23:30", "6:40"), 7.25);
  assert.equal(hoursBetween("1:10 am", "8:00 am"), 6.75);
  assert.equal(hoursBetween("", "8am"), null);
});

test("labels and relative days", () => {
  assert.equal(lbl("2026-11-03"), "Nov 3");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(rel("2026-11-05", "2026-11-04"), "tomorrow");
  assert.equal(rel("2026-11-01", "2026-11-04"), "3 days ago");
});
