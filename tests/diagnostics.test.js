import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfig, describeFetchFailure, describeTodoistFailure } from "../diagnostics.js";

test("missing secrets produce helpful messages without values", () => {
  const problems = validateConfig({});
  assert.ok(problems.some(([key]) => key === "TODOIST_API_KEY"));
  assert.ok(problems.some(([key]) => key === "MOODLE_URL"));
});
test("valid config accepts a missing optional grades feed", () => {
  assert.deepEqual(validateConfig({ TODOIST_API_KEY: "dummy", MOODLE_URL: "https://example.com/calendar.ics" }), []);
});
test("invalid and non-HTTPS calendar links fail early", () => {
  assert.ok(validateConfig({ TODOIST_API_KEY: "x", MOODLE_URL: "http://example.com/" }).length);
  assert.ok(validateConfig({ TODOIST_API_KEY: "x", MOODLE_URL: "this is not a URL" }).length);
});
test("diagnostics explain typical permission and missing feed errors", () => {
  assert.match(describeFetchFailure("Moodle", { response: { status: 403 } }), /הרשאה/);
  assert.match(describeFetchFailure("Moodle", { response: { status: 404 } }), /404/);
  assert.match(describeTodoistFailure({ response: { status: 401 } }), /TODOIST_API_KEY/);
});
test("diagnostic messages never echo private URLs, keys or server response bodies", () => {
  const error = { message: "token-secret", response: { status: 403, data: "https://private.feed/?token=secret" } };
  const messages = [describeFetchFailure("Moodle", error), describeTodoistFailure(error)].join("\n");
  assert.doesNotMatch(messages, /token-secret|private.feed|token=secret/);
});
