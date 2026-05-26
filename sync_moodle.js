import axios from "axios";
import fs from "fs";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

// Get the directory of the current script (inside the Public Action repo)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CONFIGURATION ---
const CONFIG = {
    // These should stay in the root of your PRIVATE repo
    gh_ical_path: "calendar.ics",
    gh_state_path: "todoist_state.json",
    
    // These are part of the PUBLIC repo (the action itself)
    course_map_path: path.join(__dirname, "course_map.json"),
    ignored_phrases_path: path.join(__dirname, "ignored_phrases.txt")
};

/**
 * Enhanced cleaning function to handle Hebrew normalization, 
 * Niqqud (vowels), and hidden formatting characters.
 */
const cleanText = (str) => {
    if (!str) return "";
    return str
        .normalize('NFC') // Normalize Unicode forms
        .replace(/[\u0591-\u05C7]/g, '') // Remove Hebrew Niqqud/Accents
        .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '') // Remove hidden marks
        .replace(/\s+/g, ' ') // Normalize multiple spaces
        .toLowerCase()
        .trim();
};

// טעינת נתונים חיצוניים
let courseMap = {};
let ignoredPhrases = [];

try {
    if (fs.existsSync(CONFIG.course_map_path)) {
        courseMap = JSON.parse(fs.readFileSync(CONFIG.course_map_path, "utf-8"));
    }
    if (fs.existsSync(CONFIG.ignored_phrases_path)) {
        // Robust split and pre-clean the phrases during loading
        ignoredPhrases = fs.readFileSync(CONFIG.ignored_phrases_path, "utf-8")
            .split(/\r?\n/) 
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith('//'))
            .map(phrase => cleanText(phrase));
    }
} catch (e) {
    console.error("❌ Error loading configuration files:", e.message);
}

// --- ENV VARS ---
const MOODLE_URL = process.env.MOODLE_URL;
const GRADES_URL = process.env.GRADES_URL;
const TODOIST_TOKEN = process.env.TODOIST_API_KEY;

if (!TODOIST_TOKEN) { console.error("❌ Missing TODOIST_API_KEY"); process.exit(1); }

// --- HELPERS ---
const extractEvents = (text) => {
    if (!text) return [];
    const unfoldedText = text.replace(/\r?\n[ \t]/g, "");
    return unfoldedText.match(/BEGIN:VEVENT[\s\S]+?END:VEVENT/gi) || [];
};

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
    const entry = Object.entries(courseMap).find(([key]) => cleanID(key) === target);
    return entry ? entry[1] : null;
};

const toISO = (icalDate) => {
    if (!icalDate) return null;
    const c = icalDate.replace('Z', '');
    if (c.length >= 15) {
        return `${c.substring(0, 4)}-${c.substring(4, 6)}-${c.substring(6, 8)}T${c.substring(9, 11)}:${c.substring(11, 13)}:${c.substring(13, 15)}Z`;
    } else if (c.length >= 8) {
        return `${c.substring(0, 4)}-${c.substring(4, 6)}-${c.substring(6, 8)}`;
    }
    return null;
};

const simpleHash = (str) => crypto.createHash('md5').update(str).digest('hex');

async function fetchActiveTodoistTasks(token) {
    try {
        const res = await axios.get("https://api.todoist.com/api/v1/tasks", {
            headers: { Authorization: `Bearer ${token}` },
            params: { filter: '@שיעורי בית' }
        });
        const data = res.data;
        return Array.isArray(data) ? data : (data.tasks || data.items || []);
    } catch (e) {
        console.log("⚠️ Could not fetch active tasks. Proceeding with local state only.");
        return [];
    }
}

async function run() {
    console.log(`🚀 STARTING SYNC (Loaded ${ignoredPhrases.length} phrases, ${Object.keys(courseMap).length} courses)`);

    let state = {};
    let stateChanged = false;
    let scriptErrors = [];

    try {
        if (fs.existsSync(CONFIG.gh_state_path)) {
            state = JSON.parse(fs.readFileSync(CONFIG.gh_state_path, "utf-8"));
            console.log(`✅ Loaded State DB (${Object.keys(state).length} records).`);
        }
    } catch (e) { console.log("⚠️ Corrupt State DB."); }

    const activeTasks = await fetchActiveTodoistTasks(TODOIST_TOKEN);
    let healedCount = 0;
    
    activeTasks.forEach(task => {
        const match = task.description?.match(/UID:\s*(\S+)/);
        if (match && match[1]) {
            const uid = match[1];
            if (!state[uid] || state[uid].id !== task.id) {
                state[uid] = { id: task.id, sig: state[uid]?.sig || "recovered_from_api" };
                stateChanged = true;
                healedCount++;
            }
        }
    });

    if (healedCount > 0) {
        console.log(`🩹 Auto-healed ${healedCount} task IDs from Todoist API.`);
    }

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
        } catch (e) { 
            const errorMsg = `❌ Fetch failed: ${source.name} - ${e.message}`;
            console.error(errorMsg); 
            scriptErrors.push(errorMsg);
        }
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

    // המשתנה החדש שמונע כפילויות בהדפסה
    const loggedIgnores = new Set();

    for (let e of allEvents) {
        let summary = getField(e, "SUMMARY") || "";
        let description = getField(e, "DESCRIPTION") || "";
        
        const cleanSummary = cleanText(summary);
        const cleanDesc = cleanText(description);
        
        const shouldIgnore = ignoredPhrases.some(p => {
            return cleanSummary.includes(p) || cleanDesc.includes(p);
        });

        if (shouldIgnore) {
            // מדפיס רק אם המחרוזת עדיין לא קיימת ב-Set
            if (!loggedIgnores.has(summary)) {
                console.log(`🚫 Filtered out: "${summary}"`);
                loggedIgnores.add(summary);
            }
            continue;
        }
        
        if (summary.includes("נפתח ב")) continue;
        const cid = getCourseID(e);
        const summary = getField(e, "SUMMARY") || "";
        const match = summary.replace(/^.*? - /, "").match(moodleRegex);
        if (cid && match && match[1].includes("נפתח ב")) {
            openMap.set(`${cid}|${match[2].trim()}`, getField(e, "DTSTART"));
        }
    });

    for (let e of allEvents) {
        let summary = getField(e, "SUMMARY") || "";
        let description = getField(e, "DESCRIPTION") || "";
        
        const cleanSummary = cleanText(summary);
        const cleanDesc = cleanText(description);
        
        const shouldIgnore = ignoredPhrases.some(p => {
            return cleanSummary.includes(p) || cleanDesc.includes(p);
        });

        if (shouldIgnore) {
            console.log(`🚫 Filtered out: "${summary}"`);
            continue;
        }
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

        const parsedEnd = toISO(end);
        const parsedStart = toISO(start);

        const payload = {
            content: summary,
            description: `📅 Opens: ${parsedStart || 'N/A'}\n🔑 UID: ${uid}`,
            priority: 4,
            labels: courseName ? ["שיעורי בית", courseName] : ["שיעורי בית"]
        };

        if (parsedEnd) {
            if (parsedEnd.includes('T')) {
                payload.due_datetime = parsedEnd;
            } else {
                payload.due_date = parsedEnd;
            }
        }

        try {
            if (cached && cached.id) {
                if (cached.sig !== currentSig) {
                    await axios.post(`https://api.todoist.com/api/v1/tasks/${cached.id}`, payload, {
                        headers: { Authorization: `Bearer ${TODOIST_TOKEN}`, "Content-Type": "application/json" }
                    });
                    state[uid] = { id: cached.id, sig: currentSig };
                    stateChanged = true;
                    stats.updated++;
                } else { stats.skipped++; }
            } else {
                const res = await axios.post("https://api.todoist.com/api/v1/tasks", payload, {
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
            if (e.response && (e.response.status === 404 || e.response.status === 400) && cached) {
                console.log(`🗑️ Task ID ${cached.id} (UID: ${uid}) is invalid or missing in Todoist. Removing from state.`);
                delete state[uid];
                stateChanged = true;
            } else {
                const apiError = e.response?.data ? JSON.stringify(e.response.data) : e.message;
                const errorMsg = `⚠️ Error on ${uid}: ${apiError}`;
                console.log(errorMsg);
                scriptErrors.push(errorMsg);
            }
        }
    }

    if (stateChanged || healedCount > 0) {
        fs.writeFileSync(CONFIG.gh_state_path, JSON.stringify(state, null, 2), "utf-8");
        console.log("💾 State DB updated.");
    }
    
    console.log(`\n🏁 Done: +${stats.created} | 🔄 ${stats.updated} | ⏭️ ${stats.skipped}`);

    if (scriptErrors.length > 0 && process.env.GITHUB_STEP_SUMMARY) {
        const summaryText = `### 🚨 Sync Errors Detected\n\n` + scriptErrors.map(err => `* ${err}`).join('\n');
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryText);
        process.exit(1);
    }
}

run();
