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
        console.log(`📥 Fetching from: ${CONFIG.remote_courses_url}`);
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
        console.log(`✅ Success: Loaded ${Object.keys(mapped).length} mapping variations.`);
        return mapped;
    } catch (e) {
        console.error(`❌ Diagnostic Error (Course Map): ${e.message}`);
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
    if (!TODOIST_TOKEN) return console.error("❌ Missing TODOIST_API_KEY in environment.");
    
    CONFIG.course_map = await loadRemoteCourseMap();

    let allEvents = [];
    const sources = [
        { name: "Moodle", url: MOODLE_URL },
        { name: "Grades", url: GRADES_URL }
    ];

    for (const source of sources) {
        if (!source.url) {
            console.log(`⏭️ Skipping ${source.name}: URL is not provided.`);
            continue;
        }
        try {
            console.log(`📥 Attempting to fetch ${source.name}...`);
            const res = await axios.get(source.url, { 
                timeout: 15000,
                headers: { 'User-Agent': 'Mozilla/5.0' } 
            });
            const events = res.data.match(/BEGIN:VEVENT[\s\S]+?END:VEVENT/gi) || [];
            allEvents.push(...events);
            console.log(`✅ ${source.name}: Found ${events.length} events.`);
        } catch (e) { 
            console.error(`❌ Fetch error for ${source.name}: ${e.message}`);
            if (e.response) console.error(`   Status Code: ${e.response.status}`);
        }
    }

    if (allEvents.length === 0) {
        console.log("⚠️ No events found in any source. Stopping to prevent deleting calendar.ics");
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
        if (CONFIG.ignored_phrases.some(p => summary.includes(p)) || summary.includes("נפתח ב")) return;

        const cid = getCourseID(e);
        const uid = getField(e, "UID");
        let finalEvent = e;

        if (summary.includes("תאריך הגשה:")) {
            const title = summary.split(":")[1]?.trim();
            const openTime = openMap.get(`${cid}|${title}`);
            if (openTime) finalEvent = finalEvent.replace(/^DTSTART.*$/m, `DTSTART:${openTime}`);
        }
        if (uid) uniqueMap.set(uid, finalEvent);
    });

    const icsContent = ["BEGIN:VCALENDAR", "VERSION:2.0", ...uniqueMap.values(), "END:VCALENDAR"].join("\r\n");
    fs.writeFileSync(CONFIG.gh_ical_path, icsContent);

    let state = fs.existsSync(CONFIG.gh_state_path) ? JSON.parse(fs.readFileSync(CONFIG.gh_state_path)) : {};
    
    for (const [uid, event] of uniqueMap.entries()) {
        const summary = getField(event, "SUMMARY");
        const cid = getCourseID(event);
        const courseName = CONFIG.course_map[cid];
        
        let cleanTitle = summary.replace(/(יש להגיש|תאריך הגשה):/g, "להגיש");
        if (courseName && !cleanTitle.includes(courseName)) cleanTitle = `${courseName} - ${cleanTitle}`;

        const end = getField(event, "DTEND") || getField(event, "DTSTART");
        const payload = {
            content: cleanTitle,
            due_datetime: end.replace('Z', '').substring(0,4)+'-'+end.substring(4,6)+'-'+end.substring(6,8)+'T'+end.substring(9,11)+':'+end.substring(11,13)+':'+end.substring(13,15),
            description: `🔑 UID: ${uid}`,
            labels: courseName ? ["שיעורי בית", courseName] : ["שיעורי בית"]
        };

        try {
            if (state[uid]?.id) {
                await axios.post(`https://api.todoist.com/rest/v2/tasks/${state[uid].id}`, payload, { headers: { Authorization: `Bearer ${TODOIST_TOKEN}` } });
            } else {
                const res = await axios.post("https://api.todoist.com/rest/v2/tasks", payload, { headers: { Authorization: `Bearer ${TODOIST_TOKEN}` } });
                state[uid] = { id: res.data.id };
            }
        } catch (e) { console.log(`❌ Todoist Sync error for ${uid}`); }
    }
    fs.writeFileSync(CONFIG.gh_state_path, JSON.stringify(state, null, 2));
}

run();
