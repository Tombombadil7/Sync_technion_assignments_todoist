import axios from "axios";
import fs from "fs";
import crypto from "crypto";

// --- CONFIGURATION ---
const CONFIG = {
  course_map: {
    "1140051": "פיזיקה",
    "02340128": "מבוא לפייתון",
    "00850201": "מבוא לאווירו",
    "01250001": "כימיה כללית",
    "01040041": "חדוא 1מ1",
    "01040064": "אלגברה 1מ1"
  },
  ignored_phrases: [
    "לזום",
    "שעת קבלה",
    "זום",
    "Zoom",
    "ZOOM",
    "zoom"
  ],
  gh_ical_path: "calendar.ics",
  gh_state_path: "todoist_state.json"
};

// --- ENV VARS ---
const MOODLE_URL = process.env.MOODLE_URL; //
const GRADES_URL = process.env.GRADES_URL; //
const TODOIST_TOKEN = process.env.TODOIST_API_KEY; //


if (!TODOIST_TOKEN) { console.error("❌ Missing TODOIST_API_KEY"); process.exit(1); }

// --- HELPERS ---
const extractEvents = (text) => text?.match(/BEGIN:VEVENT[\s\S]+?END:VEVENT/gi) || [];
const getField = (block, name) => block.match(new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, "mi"))?.[1].trim();

const getCourseID = (block) => {
    const cat = getField(block, "CATEGORIES")?.match(/(\d{6,9})(?:\.|$)/)?.[1];
    if (cat) return cat;
    const sum = getField(block, "SUMMARY")?.match(/\((\d{6,9})\)/)?.[1];
    if (sum) return sum;
    const m = getField(block, "UID")?.match(/\d{6,9}/g);
    return m?.find(id => CONFIG.course_map[id]) || (m?.length > 1 && m[0].startsWith('20') ? m[1] : m?.[0]);
};

const toISO = (icalDate) => {
    if (!icalDate) return null;
    const c = icalDate.replace('Z', '');
    return (c.length >= 15) ? `${c.substring(0,4)}-${c.substring(4,6)}-${c.substring(6,8)}T${c.substring(9,11)}:${c.substring(11,13)}:${c.substring(13,15)}` : null;
};

// Hash function to create short stable IDs
const simpleHash = (str) => crypto.createHash('md5').update(str).digest('hex');

// NEW: Fetch existing tasks from Todoist to prevent "Amnesia" duplicates
async function fetchActiveTodoistTasks(token) {
    try {
        // We filter by "שיעורי בית" label to only check relevant tasks
        const res = await axios.get("https://api.todoist.com/rest/v2/tasks", {
            headers: { Authorization: `Bearer ${token}` },
            params: { filter: '@שיעורי בית' } 
        });
        return res.data;
    } catch (e) {
        console.log("⚠️ Could not fetch active tasks (API error). Proceeding with local state only.");
        return [];
    }
}

async function run() {
    console.log("🚀 STARTING SYNC (No-Duplicate Mode)");

    // --- STAGE 0: LOAD STATE ---
    let state = {};
    try {
        if (fs.existsSync(CONFIG.gh_state_path)) {
            state = JSON.parse(fs.readFileSync(CONFIG.gh_state_path, "utf-8"));
            console.log(`✅ Loaded State DB (${Object.keys(state).length} records).`);
        } else { console.log("ℹ️ State DB empty/missing. Starting fresh."); }
    } catch (e) { console.log("⚠️ Corrupt State DB. Starting fresh."); }

    // --- STAGE 0.5: HEAL STATE FROM REALITY ---
    // This connects to Todoist to see what actually exists, preventing duplicates if state file is lost.
    console.log("🔍 Scanning Todoist for existing tasks...");
    const activeTasks = await fetchActiveTodoistTasks(TODOIST_TOKEN);
    let healedCount = 0;
    
    activeTasks.forEach(task => {
        // Look for UID in the task description: "UID: 12345"
        const match = task.description.match(/UID: (\d+)/);
        if (match && match[1]) {
            const foundUid = match[1];
            // If state doesn't have this task, add it so we update instead of create
            if (!state[foundUid]) {
                state[foundUid] = { id: task.id, sig: "recovered_from_api" };
                healedCount++;
            }
        }
    });
    if (healedCount > 0) console.log(`🩹 Healed state: Found ${healedCount} existing tasks in Todoist.`);

    // --- STAGE 1: FETCH SOURCES ---
    console.log("\n--- STAGE 1: FETCH SOURCES ---");
    let allEvents = [];

    // Load local cache if available
    if (fs.existsSync(CONFIG.gh_ical_path)) {
        try { allEvents.push(...extractEvents(fs.readFileSync(CONFIG.gh_ical_path, "utf-8"))); } catch(e){}
    }

    const sources = [{ name: "Moodle", url: MOODLE_URL }, { name: "Grades", url: GRADES_URL }];
    
    for (const source of sources) {
        if (!source.url) { console.log(`⏭️ Skipping ${source.name} (No URL)`); continue; }
        try {
            console.log(`📥 Fetching ${source.name}...`);
            const res = await axios.get(source.url, { responseType: 'text', headers: {"User-Agent": "Mozilla/5.0"} });
            const fetchedEvents = extractEvents(typeof res.data === 'string' ? res.data : JSON.stringify(res.data));
            allEvents.push(...fetchedEvents);
            console.log(`   Found ${fetchedEvents.length} events.`);
        } catch (e) { console.error(`❌ Fetch failed: ${source.name}`); }
    }

    // --- STAGE 2: PROCESS ---
    console.log("\n--- STAGE 2: PROCESS ---");
    const uniqueMap = new Map();
    const openMap = new Map();
    const moodleRegex = /(נפתח ב|תאריך הגשה)[:\s]+(.*)/i;
    
    // Pass 1: Open times
    allEvents.forEach(e => {
          const cid = getCourseID(e);
          const summary = getField(e, "SUMMARY") || "";
          const match = summary.replace(/^.*? - /, "").match(moodleRegex);
          if (cid && match && match[1].includes("נפתח ב")) {
              openMap.set(`${cid}|${match[2].trim()}`, getField(e, "DTSTART"));
          }
    });

    // Pass 2: Filter & Clean
    for (let e of allEvents) {
      let summary = getField(e, "SUMMARY") || "";
      if (CONFIG.ignored_phrases.some(p => summary.includes(p))) continue; 
      if (summary.includes("נפתח ב")) continue;

      const cid = getCourseID(e);
      const match = summary.replace(/^.*? - /, "").match(moodleRegex);
      if (cid && match && match[1].includes("תאריך הגשה")) {
        const openTime = openMap.get(`${cid}|${match[2].trim()}`);
        if (openTime) e = e.replace(/^DTSTART(?:;[^:]*)?:.*$/m, `DTSTART:${openTime}`);
      }

      if (cid && CONFIG.course_map[cid] && !summary.startsWith(CONFIG.course_map[cid])) {
          summary = `${CONFIG.course_map[cid]} - ${summary}`;
      }
      if (/(:| - )(יש להגיש|תאריך הגשה)/.test(summary)) summary = summary.replace(/(יש להגיש|תאריך הגשה)/g, "להגיש");
      
      e = e.replace(/^(SUMMARY(?:;[^:]*)?:)(.*)$/m, `$1${summary}`);
      const uid = getField(e, "UID");
      if (uid) uniqueMap.set(uid, e);
    }
    
    // --- STAGE 3: WRITE ICAL ---
    const finalICS = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TechnionMerged//EN", "METHOD:PUBLISH", ...uniqueMap.values(), "END:VCALENDAR"].join("\r\n");
    fs.writeFileSync(CONFIG.gh_ical_path, finalICS, "utf-8");

    // --- STAGE 4: TODOIST UPSERT ---
    console.log("\n--- STAGE 4: TODOIST UPSERT ---");
    let stats = { created: 0, updated: 0, skipped: 0 };

    for (const [uid, event] of uniqueMap.entries()) {
        let end = getField(event, "DTEND");
        let start = getField(event, "DTSTART");
        if (start === end) start = null;
        if (!end && start) { end = start; start = null; }
        if (!end) continue;
        
        const summary = getField(event, "SUMMARY");
        const cid = getCourseID(event);
        const currentSig = `${summary}|${end}|${start || 'N/A'}`;
        const cached = state[uid];

        const payload = {
            content: summary,
            due_datetime: toISO(end),
            description: `📅 Opens: ${toISO(start) || 'N/A'}\n🔑 UID: ${uid}`,
            priority: 4,
            labels: (cid && CONFIG.course_map[cid]) ? ["שיעורי בית", CONFIG.course_map[cid]] : ["שיעורי בית"]
        };

        try {
            if (cached && cached.id) {
                // Task known in state (or healed from active scan)
                if (cached.sig !== currentSig) {
                    console.log(`🔄 Updating: "${summary}"`);
                    await axios.post(`https://api.todoist.com/rest/v2/tasks/${cached.id}`, payload, {
                        headers: { Authorization: `Bearer ${TODOIST_TOKEN}`, "Content-Type": "application/json" } 
                    });
                    state[uid] = { id: cached.id, sig: currentSig };
                    stats.updated++;
                } else { stats.skipped++; }
            } else {
                // Task truly new (not in state, not in active scan)
                console.log(`📤 Creating: "${summary}"`);
                
                // SAFETY: Use Idempotency Key (UID Hash)
                // If this runs twice quickly, Todoist blocks the 2nd one.
                const res = await axios.post("https://api.todoist.com/rest/v2/tasks", payload, { 
                    headers: { 
                        Authorization: `Bearer ${TODOIST_TOKEN}`, 
                        "Content-Type": "application/json",
                        "X-Request-Id": simpleHash(uid) 
                    } 
                });
                state[uid] = { id: res.data.id, sig: currentSig };
                stats.created++;
            }
        } catch (e) { 
             console.log(`⚠️ Note on ${uid}: ${e.response?.data?.error || e.message}`);
        }
    }

    // --- STAGE 5: SAVE DB ---
    console.log(`\n🏁 Done: +${stats.created} | 🔄 ${stats.updated} | ⏭️ ${stats.skipped}`);
    if (stats.created > 0 || stats.updated > 0 || healedCount > 0) {
        fs.writeFileSync(CONFIG.gh_state_path, JSON.stringify(state, null, 2), "utf-8");
        console.log(`💾 State Saved.`);
    }
}

run();
