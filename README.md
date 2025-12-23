# 📅 Technion Moodle to Todoist Sync

כלי אוטומטי לסנכרון משימות מהמודל ומהטכניון ישירות לחשבון ה-Todoist שלך. המערכת מבוססת על הפרדה בין קוד (Public) לנתונים אישיים (Private) כדי לשמור על פרטיות מלאה.

---

## 🎯 המטרה
ניהול אוטומטי של מטלות אקדמיות ב-Todoist ללא צורך בהזנה ידנית. המערכת יודעת:
* **לתרגם** מספרי קורס לשמות קריאים (למשל: חדוא 1מ1).
* **למזג** זמני פתיחה וסגירה של מטלות למשימה אחת.
* **לסנן** רעשים כמו קישורי זום ושעות קבלה.

---

## 🚀 הוראות הטמעה (למשתמשים חדשים)

כדי להפעיל את הסנכרון, יש ליצור ריפוזיטורי פרטי שמריץ את הלוגיקה מכאן על הנתונים שלך:

### 1. יצירת Repository פרטי
* צור ריפוזיטורי חדש ב-GitHub והגדר אותו כ-**Private**.

### 2. הגדרת Secrets
בריפו הפרטי שיצרת, עבור ל-`Settings` > `Secrets and variables` > `Actions` והוסף:
* `TODOIST_API_KEY`: הטוקן האישי שלך מ-Todoist.
* `MOODLE_URL`: לינק ה-iCal מהמודל.
* `GRADES_URL`: (אופציונלי) לינק ה-iCal של הציונים מהטכניון.

### 3. יצירת קובץ ה-Workflow
צור קובץ בנתיב `.github/workflows/sync.yml` והדבק בתוכו:

```yaml
name: Task Sync
on:
  schedule:
    - cron: '*/30 * * * *' # רץ כל 30 דקות
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v3

      - name: Run Sync Logic
        uses: Tombombadil7/ical-cache-4b3fdc@main
        with:
          todoist_api_key: ${{ secrets.TODOIST_API_KEY }}
          moodle_url: ${{ secrets.MOODLE_URL }}
          grades_url: ${{ secrets.GRADES_URL }}

      - name: Save State
        run: |
          git config --global user.name 'Sync Bot'
          git config --global user.email 'bot@github.com'
          git add todoist_state.json calendar.ics
          git commit -m "Update state [skip ci]" || exit 0
          git push
```

### 4. הרשאות אחרונות
​עבור ל-Settings > Actions > General ותחת Workflow permissions בחר ב-Read and write permissions.

### ​🔄 עדכונים
​כל תיקון באג או עדכון של מיפויי קורסים
שאבצע בריפו הזה יתעדכן אצלך באופן אוטומטי בהרצה הבאה.
​נכתב עבור סטודנטים בטכניון.
