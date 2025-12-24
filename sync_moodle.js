import axios from "axios";
import fs from "fs";
import crypto from "crypto";

const CONFIG = {
  remote_courses_url: "https://raw.githubusercontent.com/michael-maltsev/technion-sap-info-fetcher/refs/heads/gh-pages/courses_2025_200.json",
  course_map: {}, 
  ignored_phrases: ["לזום", "שעת קבלה", "זום", "Zoom", "ZOOM", "zoom"],
  gh_ical_path: "calendar.ics",
  gh_state_path: "todoist_state.json"
};

const MOODLE_URL = process.env.MOODLE_URL;
const GRADES_URL = process.env.GRADES_URL;
const TODOIST_TOKEN = process.env.TODOIST_API_KEY;

const getField = (block, name) => block.match(new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, "mi"))?.[1]?.trim() || "";

async function loadRemoteCourseMap() {
    try {
        console.log(`📥 Fetching course map...`);
        const res = await axios.get(CONFIG.remote_courses_url, { timeout: 10000 });
        const rawData = res.data;
        const mapped = {};
        for (const [courseId, data] of Object.entries(rawData)) {
            if (data.general && data.general["שם מקצוע"]) {
                const cleanId = courseId.replace(/^0+/, '');
                mapped[courseId] = data.general["שם מקצוע"];
                mapped[cleanId] = data.general["שם מקצוע"];
            }
        }
        return mapped;
    } catch (e) { 
        console.error(`❌ Course Map Load Error: ${e.message}`);
        return {}; 
    }
}

const getCourseID = (block) => {
    const combined = (getField(block, "CATEGORIES") + getField(block, "SUMMARY") + getField(block, "UID"));
    const matches = combined.match(/\d{6,8}/g);
    if (!matches) return null;
    for (const id of matches) {
        if (CONFIG.course_map[id]) return id;
        const noZeros = id.replace(/^0+/, '');
        if (CONFIG.course_map[noZeros]) return noZeros;
    }
    return matches[0];
};

async function run() {
    if (!TODOIST_TOKEN) return console.error("❌ Missing TODOIST_API_KEY");
    CONFIG.course_map = await loadRemoteCourseMap();

    let allEvents = [];
    for (const url of [MOODLE_URL, GRADES_URL]) {
        if (!url) continue;
        try {
            const res = await axios.get(url);
            const events = res.data.match(/BEGIN:VEVENT[\s\S]+?END:VEVENT/gi) || [];
            allEvents.push(...events);
        } catch (e) { console.error(`❌ URL Fetch error: ${e.message}`); }
    }

    if (allEvents.length === 0) {
        console.log("⚠️ No events found.");
        return;
    }

    const uniqueMap = new Map();
    const openMap = new Map();
    
    allEvents.forEach(e => {
        const summary = getField(e, "SUMMARY");
        if (summary.includes("נפתח ב")) {
            const title = summary.split(":")[1]?.trim();
            const cid = getCourseID(e);
            if (cid && title) openMap.set(`${cid}|${title}`, getField(e, "DTSTART"));
        }
    });

    allEvents.forEach(e => {
        const summary = getField(e, "SUMMARY");
        const uid = getField(e, "UID");
        if (CONFIG.ignored_phrases.some(p => summary.includes(p)) || summary.includes("נפתח ב")) return;

        const cid = getCourseID(e);
        let finalEvent = e;

        if (summary.includes("תאריך הגשה:")) {
            const title = summary.split(":")[1]?.trim();
            const openTime = openMap.get(`${cid}|${title}`);
            if (openTime) finalEvent = finalEvent.replace(/^DTSTART.*$/m, `DTSTART:${openTime}`);
        }
        uniqueMap.set(uid, finalEvent);
    });

    fs.writeFileSync(CONFIG.gh_ical_path, ["BEGIN:VCALENDAR", "VERSION:2.0", ...uniqueMap.values(), "END:VCALENDAR"].join("\r\n"));

    let state = fs.existsSync(CONFIG.gh_state_path) ? JSON.parse(fs.readFileSync(CONFIG.gh_state_path)) : {};
    
    for (const [uid, event] of uniqueMap.entries()) {
        const summary = getField(event, "SUMMARY");
        const cid = getCourseID(event);
        const courseName = CONFIG.course_map[cid];
        
        let cleanTitle = summary.replace(/(יש להגיש|תאריך הגשה):/g, "להגיש");
        if (courseName && !cleanTitle.includes(courseName)) cleanTitle = `${courseName} - ${cleanTitle}`;

        const rawEnd = getField(event, "DTEND") || getField(event, "DTSTART");
        let todoistDate = {};

        // טיפול חכם בתאריכים: אירוע יום שלם לעומת אירוע עם שעה
        if (rawEnd.length >= 15) {
            todoistDate.due_datetime = rawEnd.replace('Z', '').substring(0,4)+'-'+rawEnd.substring(4,6)+'-'+rawEnd.substring(6,8)+'T'+rawEnd.substring(9,11)+':'+rawEnd.substring(11,13)+':'+rawEnd.substring(13,15);
        } else {
            todoistDate.due_date = rawEnd.substring(0,4)+'-'+rawEnd.substring(4,6)+'-'+rawEnd.substring(6,8);
        }

        const payload = {
            content: cleanTitle,
            ...todoistDate,
            description: `🔑 UID: ${uid}`,
            labels: courseName ? ["שיעורי בית", courseName] : ["שיעורי בית"]
        };

        try {
            const headers = { Authorization: `Bearer ${TODOIST_TOKEN.trim()}` };
            if (state[uid]?.id) {
                await axios.post(`https://api.todoist.com/rest/v2/tasks/${state[uid].id}`, payload, { headers });
            } else {
                const res = await axios.post("https://api.todoist.com/rest/v2/tasks", payload, { headers });
                state[uid] = { id: res.data.id };
            }
        } catch (e) { 
            console.error(`❌ Todoist API Error for UID ${uid}:`);
            console.error(`   Message: ${e.message}`);
            if (e.response) console.error(`   Details: ${JSON.stringify(e.response.data)}`);
        }
    }
    fs.writeFileSync(CONFIG.gh_state_path, JSON.stringify(state, null, 2));
}

run();
