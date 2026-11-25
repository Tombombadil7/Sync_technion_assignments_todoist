# 📚 סנכרון מטלות הטכניון ל-Todoist

הריפו הזה מחזיק **רק את היומן ואת מצב הסנכרון האישיים שלך**. מנוע הסנכרון מתעדכן מתוך [הריפו הציבורי](https://github.com/Tombombadil7/Sync_technion_assignments_todoist).

## התקנה ראשונית (חד-פעמית)

1. צור עותק **פרטי** מה-Template באמצעות **Use this template → Create a new repository**. ודא שהגדרת **Private**.
2. הוצא מ-Moodle את כתובת הייצוא הפרטית של יומן iCal. **אל תפרסם אותה**.
3. העתק את טוקן Todoist מתוך **Settings → Integrations → Developer**.
4. בריפו הפרטי שלך, פתח **Settings → Secrets and variables → Actions → New repository secret**, וצור:
   - `TODOIST_API_KEY`: טוקן Todoist
   - `MOODLE_URL`: קישור iCal פרטי מ-Moodle
   - `GRADES_URL`: קישור יומן ציונים, אם יש (אופציונלי)
5. פתח **Actions → Sync Technion assignments → Run workflow** להרצה ראשונה. GitHub עשוי לבקש להפעיל Workflows בריפו חדש.
6. בדוק את התוצאות ב-**Actions**. הסנכרון ירוץ בהמשך בערך אחת לשעה (GitHub עשוי לעכב הרצות מתוזמנות).

## אם משהו נכשל

לחץ על ההרצה האדומה תחת **Actions**, פתח את שלב **Run sync**, ובדוק גם את **Job summary**. הודעות נפוצות:

- **TODOIST_API_KEY חסר / Todoist דחה הרשאה:** ודא שה-Secret קיים ושהטוקן תקף.
- **MOODLE_URL חסר / קישור אינו תקין:** צור קישור ייצוא iCal חדש, והכנס אותו ל-Secret.
- **יומן לא נמצא / אין הרשאה:** כתובת היומן השתנתה או פג תוקפה.
- **Save local calendar and task state נכשל:** בדוק תחת **Settings → Actions → General → Workflow permissions** הרשאות כתיבה ל-GITHUB_TOKEN, וכן את חוקי ההגנה על ענף `main`. אם כללי ההגנה חוסמים את הבוט, צריך לאפשר את העדכון האוטומטי בדרך מתאימה; אין לבטל אבטחה בלי להבין את ההשפעה.

אין להעלות לריפו טוקנים, קישורי iCal פרטיים או פרטי התחברות בקבצים רגילים.

> קובצי `calendar.ics` ו-`todoist_state.json` נוצרים בהרצה הראשונה. אל תוסיף אותם לריפו ציבורי.
