// User-facing diagnostics. No credentials or feed URLs are included in messages.
const tips = {
  MOODLE_URL: "פתח את Moodle > Calendar > Export calendar, ובחר קישור iCal פרטי.",
  TODOIST_API_KEY: "פתח Todoist > Settings > Integrations > Developer והעתק API token.",
  GRADES_URL: "השדה אופציונלי. השאר אותו ריק אם אין לך קישור יומן נוסף."
};
export function validateConfig(env) {
  const problems = [];
  if (!env.TODOIST_API_KEY?.trim()) problems.push(["TODOIST_API_KEY", "חסר טוקן Todoist. " + tips.TODOIST_API_KEY]);
  if (!env.MOODLE_URL?.trim() && !env.GRADES_URL?.trim()) problems.push(["MOODLE_URL", "חסר קישור יומן. " + tips.MOODLE_URL]);
  for (const key of ["MOODLE_URL", "GRADES_URL"]) {
    const value = env[key]?.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") problems.push([key, "קישור היומן חייב להתחיל ב-https://"]);
    } catch { problems.push([key, "קישור היומן אינו כתובת URL תקינה. " + tips[key]]); }
  }
  return problems;
}
export function describeFetchFailure(source, error) {
  const status = error.response?.status;
  if (status === 401 || status === 403) return `אין הרשאה לקרוא את יומן ${source}. נסה לייצא קישור iCal חדש.`;
  if (status === 404) return `יומן ${source} לא נמצא (404). בדוק שהקישור לא השתנה.`;
  if (status === 429) return `שרת ${source} מגביל בקשות (429). נסה שוב מאוחר יותר.`;
  if (status >= 500) return `שרת ${source} אינו זמין כרגע (${status}). נסה שוב מאוחר יותר.`;
  return `לא ניתן להוריד את יומן ${source}. בדוק את הקישור ואת זמינות האתר.`;
}
export function describeTodoistFailure(error) {
  const status = error.response?.status;
  if (status === 401 || status === 403) return "Todoist דחה את ההרשאה. בדוק את TODOIST_API_KEY.";
  if (status === 429) return "Todoist מגביל בקשות כרגע. נסה שוב מאוחר יותר.";
  if (status >= 500) return "שירות Todoist אינו זמין כרגע. נסה שוב מאוחר יותר.";
  if (status === 400) return "Todoist דחה את נתוני המשימה (400). בדוק את התוכן והתאריך.";
  return "קריאת Todoist נכשלה. בדוק את החיבור והרשאות ה-API.";
}
export function appendSummary(env, title, errors) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  const fs = requireFs();
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `### ${title}\n\n${errors.map(e => "- " + e).join("\n")}\n`);
}
// Imported as an ES module: fs import below is hoisted.
import fs from "node:fs";
function requireFs() { return fs; }
