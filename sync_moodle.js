import axios from "axios";
import fs from "fs";
import crypto from "crypto";

// --- CONFIGURATION ---
const CONFIG = {
  // כתובת ה-Raw JSON של כלל קורסי הטכניון
  remote_courses_url: "https://raw.githubusercontent.com/michael-maltsev/technion-sap-info-fetcher/refs/heads/gh-pages/courses_2025_200.json",
  course_map: {}, // יתמלא בזמן ריצה
  ignored_phrases: [
    "לזום", "שעת קבלה", "זום", "Zoom", "ZOOM", "zoom"
  ],
  gh_ical_path: "calendar.ics",
  gh_state_path: "todoist_state.json"
};

// --- ENV VARS ---
const MOODLE_URL = process.env.MOODLE_URL;
const GRADES_URL = process.env.GRADES_URL;
const TODOIST_TOKEN = process.env.TODOIST_API_KEY;

if (!TODOIST_TOKEN) { 
    console.error("❌ Missing TODOIST_API_KEY"); 
    process.exit(1); 
}

// --- HELPERS ---
const extractEvents = (text) => text?.match(/BEGIN:VEVENT[\s\S]+?END:VEVENT/gi) || [];
const getField = (block, name) => block.match(new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, "mi"))?.[1].trim();

/**
 * פונקציה למשיכת מפת הקורסים מה-URL החיצוני
 * מעבדת את המבנה שבו לכל קורס יש אובייקט "general"
 */
async function loadRemoteCourseMap() {
    try {
        console.log("📥 Fetching remote course map...");
        const res = await axios.get(CONFIG.remote_courses_url);
        const rawData = res.data;
        const mapped = {};

        // מעבר על כל הקורסים ב-JSON וחילוץ מספר ושם
        Object.values(rawData).forEach(course => {
            if (course.general && course.general["מספר מקצוע"] && course.general["שם מקצוע"]) {
                const id = course.general["מספר מקצוע"].toString();
                mapped[id] = course.general["שם מקצוע"];
            }
        });

        console.log(`✅ Loaded ${Object.keys(mapped).length} courses from remote source.`);
        return mapped;
    } catch (e) {
        console.error("⚠️ Failed to load remote map, continuing with empty map.");
        return {};
    }
}

const getCourseID = (block) => {
    const combinedText = (getField(block, "CATEGORIES") || "") + 
                         (getField(block, "SUMMARY") || "") + 
                         (getField(block, "UID") || "");
    
    // חיפוש רצף של 7-8 ספרות
    const matches = combinedText.match(/\d{7,8}/g);
    return matches?.find(id => CONFIG.course_map[id]) || matches?.[0];
};

const toISO = (icalDate) => {
    if (!icalDate) return null;
    const c = icalDate.replace('Z', '');
    return (c.length >= 15) ? `${c.substring(0,4)}-${c.substring(4,6)}-${c.substring(6,8)}T${c.substring(9,11)}:${c.substring(11,13)}:${c.substring(13,15)}` : null;
};

const simpleHash = (str) => crypto.createHash('md5').update(str).digest('hex');

async function run() {
    console.log("🚀 STARTING SYNC (Remote Map Mode)");

    // שלב 0: טעינת המפה החיצונית
    CONFIG.course_map = await loadRemoteCourseMap();

    // שלב 1: טעינת State קיים למניעת כפילויות
    let state = {};
    try {
        if (fs.existsSync(CONFIG.gh_state_path)) {
            state = JSON.parse(fs.readFileSync(CONFIG.gh_state_path, "utf-8"));
        }
    } catch (e) { console.log("⚠️ State DB issue."); }

    // שלב 2: איחוד מקורות (Moodle + Grades)
    let allEvents = [];
    const sources = [{ name: "Moodle", url: MOODLE_URL }, { name: "Grades", url: GRADES_URL }];
    
    for (const source of sources) {
        if (!source.url) continue;
        try {
            const res = await axios.get(source.url, { responseType: 'text' });
            allEvents.push(...extractEvents(res.data));
        } catch (e) { console.error(`❌ Failed: ${source.name}`); }
    }

    const uniqueMap = new Map();
    const openMap = new Map();
    
    // עיבוד זמני פתיחה וסגירה
    allEvents.forEach(e => {
          const cid = getCourseID(e);
          const summary = getField(e, "SUMMARY") || "";
          if (cid && summary.includes("נפתח ב")) {
              const taskTitle = summary.split("נפתח ב:")[1]?.trim();
              openMap.set(`${cid}|${taskTitle}`, getField(e, "DTSTART"));
          }
    });

    for (let e of allEvents) {
      let summary = getField(e, "SUMMARY") || "";
      if (CONFIG.ignored_phrases.some(p => summary.includes(p)) || summary.includes("נפתח ב")) continue;

      const cid = getCourseID(e);
      const taskTitle = summary.includes("תאריך הגשה:") ? summary.split("תאריך הגשה:")[1]?.trim() : null;
      
      if (cid && taskTitle) {
          const openTime = openMap.get(`${cid}|${taskTitle}`);
          if (openTime) e = e.replace(/^DTSTART.*$/m, `DTSTART:${openTime}`);
      }

      const uid = getField(e, "UID");
      if (uid) uniqueMap.set(uid, e);
    }

    // שמירת ה-ICS המאוחד לגיבוי
    const finalICS = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TechnionMerged//EN", ...uniqueMap.values(), "END:VCALENDAR"].join("\r\n");
    fs.writeFileSync(CONFIG.gh_ical_path, finalICS);

    // שלב 3: סנכרון ל-Todoist
    let stats = { created: 0, updated: 0, skipped: 0 };

    for (const [uid, event] of uniqueMap.entries()) {
        const summary = getField(event, "SUMMARY");
        const cid = getCourseID(event);
        const courseName = CONFIG.course_map[cid]; 
        
        let end = getField(event, "DTEND") || getField(event, "DTSTART");
        let start = getField(event, "DTSTART");
        
        let cleanSummary = summary.replace(/(יש להגיש|תאריך הגשה):/g, "להגיש");
        if (courseName && !cleanSummary.includes(courseName)) {
            cleanSummary = `${courseName} - ${cleanSummary}`;
        }

        const currentSig = `${cleanSummary}|${end}|${start}`;
        const cached = state[uid];

        const payload = {
            content: cleanSummary,
            due_datetime: toISO(end),
            description: `📅 Opens: ${toISO(start) || 'N/A'}\n🔑 UID: ${uid}`,
            priority: 4,
            labels: courseName ? ["שיעורי בית", courseName] : ["שיעורי בית"]
        };

        try {
            if (cached?.id) {
                if (cached.sig !== currentSig) {
                    await axios.post(`https://api.todoist.com/rest/v2/tasks/${cached.id}`, payload, {
                        headers: { Authorization: `Bearer ${TODOIST_TOKEN}` } 
                    });
                    state[uid] = { id: cached.id, sig: currentSig };
                    stats.updated++;
                } else { stats.skipped++; }
            } else {
                const res = await axios.post("https://api.todoist.com/rest/v2/tasks", payload, { 
                    headers: { Authorization: `Bearer ${TODOIST_TOKEN}`, "X-Request-Id": simpleHash(uid) } 
                });
                state[uid] = { id: res.data.id, sig: currentSig };
                stats.created++;
            }
        } catch (e) { console.log(`⚠️ Sync error on ${uid}`); }
    }

    fs.writeFileSync(CONFIG.gh_state_path, JSON.stringify(state, null, 2));
    console.log(`🏁 Done: +${stats.created} | 🔄 ${stats.updated} | ⏭️ ${stats.skipped}`);
}

run();
