import fs from "node:fs";

const fixture = JSON.parse(process.env.TEST_FIXTURE || "{}");
const record = (method, url, payload) => fs.appendFileSync(
  process.env.TEST_CALLS_FILE,
  JSON.stringify({ method, url, payload }) + "\n"
);

export default {
  async get(url) {
    record("GET", url);
    if (url.includes("api.todoist.com")) {
      if (fixture.failTodoistGet) throw new Error("Todoist unavailable");
      return { data: fixture.activeTasks || [] };
    }
    if (url === "https://fixture.test/moodle") {
      if (fixture.failMoodle) throw new Error("Moodle unavailable");
      return { data: fixture.moodle || "" };
    }
    if (url === "https://fixture.test/grades") {
      if (fixture.failGrades) throw new Error("Grades unavailable");
      return { data: fixture.grades || "" };
    }
    throw new Error("Unexpected HTTP GET (blocked): " + url);
  },
  async post(url, payload) {
    record("POST", url, payload);
    const id = url.match(/\/tasks\/(.+)$/)?.[1];
    if (fixture.invalidTaskId && id === fixture.invalidTaskId) {
      throw { response: { status: 404, data: { error: "not found" } } };
    }
    if (fixture.failPost) throw new Error("Todoist write failure");
    if (url === "https://api.todoist.com/api/v1/tasks") return { data: { id: "mock-new-task" } };
    if (id) return { data: {} };
    throw new Error("Unexpected HTTP POST (blocked): " + url);
  }
};
