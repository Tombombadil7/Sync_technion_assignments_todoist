# 📅 Technion Moodle → Todoist

סנכרון אוטומטי של מטלות מהיומן של Moodle (ויומן נוסף, אם יש) אל Todoist, באמצעות GitHub Actions. אין צורך בשרת או בהתקנת תוכנה.

הסנכרון מזהה קורסים, מאחד אירועי פתיחה והגשה, מסנן אירועים לא רלוונטיים ומונע יצירת משימות כפולות.

## 🚀 התחלה מהירה

[![יצירת ריפו פרטי מהתבנית](https://img.shields.io/badge/Use_this_template-Start_here-2ea44f?style=for-the-badge&logo=github)](https://github.com/Tombombadil7/technion-todoist-starter/generate)


1. לחץ על הכפתור, תן שם לריפו החדש ובחר **Private**.
2. העתק את קישור ה-iCal הפרטי מתוך Moodle ואת טוקן ה-API מתוך Todoist.
3. בריפו הפרטי החדש פתח **Settings → Secrets and variables → Actions → New repository secret**, והוסף:
   - `TODOIST_API_KEY` — טוקן ה-API של Todoist.
   - `MOODLE_URL` — קישור ה-iCal האישי של Moodle.
   - `GRADES_URL` — קישור ליומן נוסף (אופציונלי).
4. פתח **Actions → Sync Technion assignments → Run workflow** להרצה הראשונה.
5. בדוק שהמשימות נוצרו ב-Todoist. בהמשך GitHub יפעיל את הסנכרון באופן מתוזמן.

**לא מצאת את Run workflow?** ודא שה-Workflows מופעלים בריפו החדש. אם שמירת קובצי המצב נכשלת, בדוק הרשאות כתיבה ב-**Settings → Actions → General → Workflow permissions**.

## 🩺 תקלה בסנכרון?

פתח את ההרצה שנכשלה תחת **Actions**, ולאחר מכן את **Job summary** או את שלב **Run sync**. הודעות השגיאה מסבירות אם חסרה הגדרה, קישור היומן אינו תקין או ש-Todoist דחה את הבקשה.

לבעיות נוספות אפשר [לפתוח Issue](https://github.com/Tombombadil7/Sync_technion_assignments_todoist/issues), **בלי לצרף טוקנים או קישורי יומן פרטיים**.

## 🔧 למפתחים ולתורמים

מנוע הסנכרון נמצא ב-[`sync_moodle.js`](./sync_moodle.js), והבדיקות האוטומטיות נמצאות בתיקיית [`tests`](./tests). כל Push או PR מריץ את בדיקות הסימולציה ללא קריאות ל-Todoist האמיתי.

קובצי התבנית להכנת ריפו ה-Template נמצאים בתיקיית [`starter-template`](./starter-template). העתק את תוכנה **לשורש** ריפו Template נפרד והפעל בהגדרותיו **Template repository**.

הנתונים האישיים נשמרים בריפו הפרטי של כל משתמש; לעולם אל תעלה אותם לריפו הציבורי.
