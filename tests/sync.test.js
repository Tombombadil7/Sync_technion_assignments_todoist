import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve("sync_moodle.js");
const hook = resolve("tests/mock-axios.js");

function event(uid, summary, start = "20261123T090000Z", end = "20261130T120000Z", course = "1040064", description = "") {
  return [
    "BEGIN:VEVENT", "UID:" + uid, "CATEGORIES:" + course,
    "SUMMARY:" + summary, "DESCRIPTION:" + description,
    "DTSTART:" + start, "DTEND:" + end, "END:VEVENT"
  ].join("\r\n");
}

function simulate({ moodle = "", grades = "", activeTasks = [], state, calendar, ...options } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sync-test-"));
  const callsFile = join(dir, "calls.jsonl");
  writeFileSync(callsFile, "");
  if (state !== undefined) writeFileSync(join(dir, "todoist_state.json"), JSON.stringify(state));
  if (calendar !== undefined) writeFileSync(join(dir, "calendar.ics"), calendar);
  const fixture = { moodle, grades, activeTasks, ...options };
  const result = spawnSync(process.execPath, ["--import", hook, script], {
    cwd: dir, encoding: "utf8",
    env: {
      ...process.env,
      TODOIST_API_KEY: "FAKE-TOKEN-NO-REAL-ACCESS",
      MOODLE_URL: "https://fixture.test/moodle",
      GRADES_URL: "https://fixture.test/grades",
      TEST_FIXTURE: JSON.stringify(fixture),
      TEST_CALLS_FILE: callsFile,
      GITHUB_STEP_SUMMARY: join(dir, "summary.md")
    }
  });
  const calls = readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const savedState = existsSync(join(dir, "todoist_state.json"))
    ? JSON.parse(readFileSync(join(dir, "todoist_state.json"), "utf8")) : {};
  const outputCalendar = readFileSync(join(dir, "calendar.ics"), "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { result, calls, state: savedState, calendar: outputCalendar };
}

function writes(run) { return run.calls.filter(c => c.method === "POST"); }
function assertPassed(run) {
  assert.equal(run.result.status, 0, run.result.stderr + "\n" + run.result.stdout);
  assert.equal(run.result.signal, null);
}

test("creates one Todoist task with correct labels, due date, and persisted UID", () => {
  const run = simulate({ moodle: event("create-1", "תרגיל 1") });
  assertPassed(run);
  assert.equal(writes(run).length, 1);
  const task = writes(run)[0];
  assert.equal(task.url, "https://api.todoist.com/api/v1/tasks");
  assert.match(task.payload.content, /אלגברה 1מ1/);
  assert.equal(task.payload.due_datetime, "2026-11-30T12:00:00Z");
  assert.deepEqual(task.payload.labels, ["שיעורי בית", "אלגברה 1מ1"]);
  assert.match(task.payload.description, /UID: create-1/);
  assert.equal(run.state["create-1"].id, "mock-new-task");
});

test("skips unchanged task without writing to Todoist", () => {
  const e = event("same-1", "תרגיל 2");
  const summary = "אלגברה 1מ1 - תרגיל 2";
  const signature = summary + "|20261130T120000Z|20261123T090000Z";
  const run = simulate({ moodle: e, state: { "same-1": { id: "existing-1", sig: signature } } });
  assertPassed(run);
  assert.equal(writes(run).length, 0);
  assert.match(run.result.stdout, /⏭️ 1/);
});

test("updates an existing task when its deadline changes", () => {
  const run = simulate({
    moodle: event("changed-1", "תרגיל 3"),
    state: { "changed-1": { id: "existing-2", sig: "old-signature" } }
  });
  assertPassed(run);
  assert.equal(writes(run).length, 1);
  assert.match(writes(run)[0].url, /\/tasks\/existing-2$/);
  assert.match(run.state["changed-1"].sig, /20261130T120000Z/);
});

test("deduplicates the same UID across feeds", () => {
  const e = event("duplicate-1", "תרגיל כפול");
  const run = simulate({ moodle: e, grades: e });
  assertPassed(run);
  assert.equal(writes(run).length, 1);
  assert.equal((run.calendar.match(/BEGIN:VEVENT/g) || []).length, 1);
});

test("merges opening date with submission date for matching assignment", () => {
  const label = "תרגיל 7";
  const open = event("open-7", "נפתח ב: " + label, "20261120T080000Z");
  const due = event("due-7", "תאריך הגשה: " + label, "20261123T090000Z");
  const run = simulate({ moodle: open + "\r\n" + due });
  assertPassed(run);
  assert.equal(writes(run).length, 1);
  assert.equal(writes(run)[0].payload.description.includes("2026-11-20T08:00:00Z"), true);
  assert.equal((run.calendar.match(/BEGIN:VEVENT/g) || []).length, 1);
});

test("ignores a calendar entry with no due/end date for Todoist", () => {
  const e = ["BEGIN:VEVENT", "UID:no-end", "SUMMARY:בלי סיום", "END:VEVENT"].join("\r\n");
  const run = simulate({ moodle: e });
  assertPassed(run);
  assert.equal(writes(run).length, 0);
});

test("recovers an existing task from Todoist API and updates instead of creating", () => {
  const run = simulate({
    moodle: event("recovered-1", "תרגיל 4"),
    activeTasks: [{ id: "remote-1", description: "🔑 UID: recovered-1" }]
  });
  assertPassed(run);
  assert.equal(writes(run).length, 1);
  assert.match(writes(run)[0].url, /\/tasks\/remote-1$/);
  assert.equal(run.state["recovered-1"].id, "remote-1");
});

test("removes invalid task IDs from local state after a 404", () => {
  const run = simulate({
    moodle: event("invalid-1", "תרגיל 5"),
    state: { "invalid-1": { id: "gone-1", sig: "old" } },
    invalidTaskId: "gone-1"
  });
  assertPassed(run);
  assert.equal(writes(run).length, 1);
  assert.equal(run.state["invalid-1"], undefined);
});

test("reports a failed Moodle download and exits nonzero", () => {
  const run = simulate({ failMoodle: true });
  assert.notEqual(run.result.status, 0);
  assert.match(run.result.stderr, /Fetch failed: Moodle/);
  assert.equal(writes(run).length, 0);
});

test("reports Todoist write failures and exits nonzero", () => {
  const run = simulate({ moodle: event("failed-1", "תרגיל 6"), failPost: true });
  assert.notEqual(run.result.status, 0);
  assert.match(run.result.stdout, /Error on failed-1/);
});

test("falls back to state when fetching Todoist active tasks fails", () => {
  const run = simulate({
    moodle: event("fallback-1", "תרגיל 8"),
    state: { "fallback-1": { id: "existing-8", sig: "old" } },
    failTodoistGet: true
  });
  assertPassed(run);
  assert.match(writes(run)[0].url, /\/tasks\/existing-8$/);
});

test("filters ignored phrases from committed configuration", () => {
  const phrases = readFileSync(resolve("ignored_phrases.txt"), "utf8")
    .split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("//"));
  assert.ok(phrases.length > 0, "Expected ignored phrases configuration");
  const run = simulate({ moodle: event("ignored-1", phrases[0]) });
  assertPassed(run);
  assert.equal(writes(run).length, 0);
  assert.doesNotMatch(run.calendar, /UID:ignored-1/);
});
