import axios from "axios";
import fs from "fs";
import crypto from "crypto";

// --- CONFIGURATION ---
const CONFIG = {
    course_map: {
        "0850201": "מבוא לאווירו",
        "3240033": "אנגלית טכנית",
        "1140051": "פיסיקה 1",
        "1040064": "אלגברה 1מ1",
        "1040041": "חדו\"א 1מ1",
        "2340128": "מבוא לפייתון",
        "1250001": "כימיה כללית",
        "1140052": "פיסיקה 2",
        "1040131": "מד\"ר",
        "1040043": "חדו\"א 2מ'1",
        "0845006": "מכניקת המוצקים",
        "3140200": "חומרים לתעופה",
        "3940800": "חינוך גופני 1",
        "1040215": "פונקציות מרוכבות",
        "0940411": "הסתברות ת'",
        "1040228": "מד\"ח",
        "0840225": "דינמיקה מ'",
        "0840213": "תרמודינמיקה",
        "3940801": "חינוך גופני 2",
        "1140054": "פיסיקה 3",
        "0840737": "מערכות דינמיות",
        "0840311": "אווירודינמיקה 1",
        "0840515": "מבוא לאלסטיות",
        "0840135": "אנליזה נומרית",
        "0840630": "שרטוט הנדסי",
        "0440102": "בטיחות חשמל",
        "0840738": "תורת הבקרה",
        "0840314": "זרימה צמיגה",
        "0840154": "שיטות ניסוי",
        "0840312": "זרימה דחיסה",
        "0840641": "תכן וייצור",
        "0440098": "חשמל לתעופה"
    },
    ignored_phrases: ["לזום", "שעת קבלה", "זום", "Zoom", "ZOOM", "zoom"],
    gh_ical_path: "calendar.ics",
    gh_state_path: "todoist_state.json"
};

// --- ENV VARS ---
const MOODLE_URL = process.env.MOODLE_URL;
const GRADES_URL = process.env.GRADES_URL;
const TODOIST_TOKEN = process.env.TODOIST_API_KEY;

if (!TODOIST_TOKEN) { console.error("❌ Missing TODOIST_API_KEY"); process.exit(1); }

// --- HELPERS ---
const extractEvents = (text) => text?.match(/BEGIN:VEVENT[\s\S]+?END:VEVENT/gi) || [];
const getField = (block, name) => block.match(new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, "mi"))?.[1].trim();

const cleanID = (id) => id?.replace(/^0+/, "");
const getCourseID = (block) => {
    const cat = getField(block, "CATEGORIES")?.match(/(\d{6,9})(?:\.|$)/)?.[1];
    const sum = getField(block, "SUMMARY")?.match(/\((\d{6,9})\)/)?.[1];
    const m = getField(block, "UID")?.match(/\d{6,9}/g);

    const rawID = cat || sum || (m?.find(id => getCourseName(id)) || (m?.length > 1 && m[0].startsWith('20') ? m[1] : m?.[0]));
    return cleanID(rawID);
};

const getCourseName = (id) => {
    if (!id) return null;
    const target = cleanID(id);
    const entry = Object.entries(CONFIG.course_map).find(([key]) => cleanID(key) === target);
    return entry ? entry[1] : null;
};

const toISO = (icalDate) => {
    if (!icalDate) return null;
    const c = icalDate.replace('Z', '');
    return (c.length >= 15) ? `${c.substring(0, 4)}-${c.substring(4, 6)}-${c.substring(6, 8)}T${c.substring(9, 11)}:${c.substring(11, 13)}:${c.substring(13, 15)}` : null;
};

const simpleHash = (str) => crypto.createHash('md5').update(str).digest('hex');

async function fetchActiveTodoistTasks(token) {
    try {
        const res = await axios.get("https://api.todoist.com/rest/v2/tasks", {
            headers: { Authorization: `Bearer ${token}` },
            params: { filter: '@שיעורי בית' }
        });
        return res.data;
    } catch (e) {
        console.log("⚠️ Could not fetch active tasks. Proceeding with local state only.");
        return [];
    }
}

async function run() {
    console.log("🚀 STARTING SYNC (Flexible ID Mode)");

    let state = {};
    let stateChanged = false; // דגל למעקב אחרי שינויים ב-State

    try {
        if (fs.existsSync(CONFIG.gh_state_path)) {
            state = JSON.parse(fs.readFileSync(CONFIG.gh_state_path, "utf-8"));
            console.log(`✅ Loaded State DB (${Object.keys(state).length} records).`);
        }
    } catch (e) { console.log("⚠️ Corrupt State DB."); }

    const activeTasks = await fetchActiveTodoistTasks(TODOIST_TOKEN);
    let healedCount = 0;
    activeTasks.forEach(task => {
        const match = task.description.match(/UID: (\d+)/);
        if (match && match[1] && !state[match[1]]) {
            state[match[1]] = { id: task.id, sig: "recovered_from_api" };
            stateChanged = true;
            healedCount++;
        }
    });

    let allEvents = [];
    if (fs.existsSync(CONFIG.gh_ical_path)) {
        try { allEvents.push(...extractEvents(fs.readFileSync(CONFIG.gh_ical_path, "utf-8"))); } catch (e) { }
    }

    const sources = [{ name: "Moodle", url: MOODLE_URL }, { name: "Grades", url: GRADES_URL }];
    for (const source of sources) {
        if (!source.url) continue;
        try {
            const res = await axios.get(source.url, { responseType: 'text', headers: { "User-Agent": "Mozilla/5.0" } });
            allEvents.push(...extractEvents(res.data));
        } catch (e) { console.error(`❌ Fetch failed: ${source.name}`); }
    }

    const uniqueMap = new Map();
    const openMap = new Map();
    const moodleRegex = /(נפתח ב|תאריך הגשה)[:\s]+(.*)/i;
    allEvents.forEach(e => {
        const cid = getCourseID(e);
        const summary = getField(e, "SUMMARY") || "";
        const match = summary.replace(/^.*? - /, "").match(moodleRegex);
        if (cid && match && match[1].includes("נפתח ב")) {
            openMap.set(`${cid}|${match[2].trim()}`, getField(e, "DTSTART"));
        }
    });

    for (let e of allEvents) {
        let summary = getField(e, "SUMMARY") || "";
        if (CONFIG.ignored_phrases.some(p => summary.includes(p))) continue;
        if (summary.includes("נפתח ב")) continue;

        const cid = getCourseID(e);
        const courseName = getCourseName(cid);
        const match = summary.replace(/^.*? - /, "").match(moodleRegex);

        if (cid && match && match[1].includes("תאריך הגשה")) {
            const openTime = openMap.get(`${cid}|${match[2].trim()}`);
            if (openTime) e = e.replace(/^DTSTART(?:;[^:]*)?:.*$/m, `DTSTART:${openTime}`);
        }

        if (courseName && !summary.startsWith(courseName)) {
            summary = `${courseName} - ${summary}`;
        }
        if (/(:| - )(יש להגיש|תאריך הגשה)/.test(summary)) summary = summary.replace(/(יש להגיש|תאריך הגשה)/g, "להגיש");
        e = e.replace(/^(SUMMARY(?:;[^:]*)?:)(.*)$/m, `$1${summary}`);
        const uid = getField(e, "UID");
        if (uid) uniqueMap.set(uid, e);
    }

    const finalICS = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TechnionMerged//EN", "METHOD:PUBLISH", ...uniqueMap.values(), "END:VCALENDAR"].join("\r\n");
    fs.writeFileSync(CONFIG.gh_ical_path, finalICS, "utf-8");

    let stats = { created: 0, updated: 0, skipped: 0 };
    for (const [uid, event] of uniqueMap.entries()) {
        let end = getField(event, "DTEND");
        let start = getField(event, "DTSTART");
        if (!end) continue;

        const summary = getField(event, "SUMMARY");
        const courseName = getCourseName(getCourseID(event));
        const currentSig = `${summary}|${end}|${start || 'N/A'}`;
        const cached = state[uid];

        const payload = {
            content: summary,
            due_datetime: toISO(end),
            description: `📅 Opens: ${toISO(start) || 'N/A'}\n🔑 UID: ${uid}`,
            priority: 4,
            labels: courseName ? ["שיעורי בית", courseName] : ["שיעורי בית"]
        };

        try {
            if (cached && cached.id) {
                if (cached.sig !== currentSig) {
                    await axios.post(`https://api.todoist.com/rest/v2/tasks/${cached.id}`, payload, {
                        headers: { Authorization: `Bearer ${TODOIST_TOKEN}`, "Content-Type": "application/json" }
                    });
                    state[uid] = { id: cached.id, sig: currentSig };
                    stateChanged = true;
                    stats.updated++;
                } else { stats.skipped++; }
            } else {
                const res = await axios.post("https://api.todoist.com/rest/v2/tasks", payload, {
                    headers: {
                        Authorization: `Bearer ${TODOIST_TOKEN}`,
                        "Content-Type": "application/json",
                        "X-Request-Id": simpleHash(uid)
                    }
                });
                state[uid] = { id: res.data.id, sig: currentSig };
                stateChanged = true;
                stats.created++;
            }
        } catch (e) {
            if (e.response && e.response.status === 404 && cached) {
                console.log(`🗑️ Task ${cached.id} (UID: ${uid}) not found in Todoist. Removing from state.`);
                delete state[uid];
                stateChanged = true; // סימון לשינוי כדי שהמחיקה תישמר לקובץ
            } else {
                console.log(`⚠️ Error on ${uid}: ${e.message}`);
            }
        }
    }

    // שמירה אם היו יצירות, עדכונים, ריפוי או מחיקות
    if (stateChanged || healedCount > 0) {
        fs.writeFileSync(CONFIG.gh_state_path, JSON.stringify(state, null, 2), "utf-8");
        console.log("💾 State DB updated with changes.");
    }
    console.log(`\n🏁 Done: +${stats.created} | 🔄 ${stats.updated} | ⏭️ ${stats.skipped}`);
}

run();
