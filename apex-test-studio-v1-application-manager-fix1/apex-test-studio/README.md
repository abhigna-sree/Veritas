# APEX Test Studio

Upload an Excel file of test cases, run them against your Oracle APEX app, watch live PASS/FAIL, and replay every execution video.
**All data lives in PostgreSQL** (workbooks, runs, results, videos, screenshots, settings, history). Nothing is stored on disk.

## Setup (once)
    cd backend
    pip install -r requirements.txt            # openpyxl, playwright, psycopg
    copy .env.example .env                      # then paste your PostgreSQL URL into DATABASE_URL
The first start creates the tables automatically (`ats_*`). Works with Neon, Supabase or any PostgreSQL.

## Run
1. Start Chrome and log in to your APEX app (keep the Timesheet page open in a tab):
   `chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\chrome-test`
2. `cd backend && python server.py`  ->  open http://localhost:8000
3. Open the **Applications** tab. Your Timesheet app is registered automatically on first start (from `APEX_BASE` or the URL you saved before). Check its Base URL, click **Test connection**, then go to **Studio**, drop the Excel file and click Run.

Preview without APEX: `DEMO=1 python server.py` (PowerShell: `$env:DEMO="1"; python server.py`) - simulated results with real recorded videos, still saved in the DB.

## Applications (Feature 1)
- **Applications tab**: add, edit and delete applications. Each has a name, Base URL, environment (development / test / staging), authentication type and description.
- **Test connection** checks that the Base URL answers (any HTTP reply, even a login redirect, counts as reachable).
- The **application switcher** (top right) chooses what you are testing. Custom tests, uploaded workbooks, runs, history and trends are all kept **per application**; History has a "Show all applications" switch.
- The URL used for a run always comes from the selected application (the old "APEX app URL" box in Run settings is gone).
- Deleting an application also deletes its custom tests and workbooks; its run history is kept.
- Upgrading is automatic: existing tests, workbooks and runs are attached to "Timesheet App" on first start.
- Login is still your logged-in Chrome (port 9222). Automatic multi-user login comes in the next feature.

## What's in the UI
- **Test library**: upload an Excel file and/or create your own tests. Every test is a card; tick the ones you want, then **Run N selected** (or **Run all**). Each card also has **Run only this**.
- **Create a test case**: build it with steps (open a page, click, type, choose, press a key, wait, expect text / URL) or pick one of the built-in checks and set its data. **Save & run with video** records it straight away. Custom tests are stored in PostgreSQL and can be edited or deleted.
- **Results**: pass-rate ring, live counts, and a video wall - hover a card to preview, click for the player (seek, 1x/1.5x/2x, left/right arrows to move between tests, screenshot tab). Tests that passed in the previous run and fail now are flagged as regressions.
- **History & Insights**: pass-rate trend (click a bar to open that run), most-failing tests, and every past run with Open / Report / CSV / Delete. Errors always appear as a message at the bottom right.
- **Database chip**: connection status and storage meter. Light/dark theme and run settings are saved in the database.

### Step targets
A step target can be visible text (`Save`), a field label (`Hours`), or a CSS selector (`#P4_HOURS`, or `css=button.save`).

## Storage notes
Videos are stored as bytea and streamed back in 1 MB pieces with HTTP Range, so seeking works. To stay inside a free tier
(Neon = 0.5 GB) only the newest `KEEP_RUNS` runs are kept (default 8; set in `.env`). Delete any run from the History tab.

## Security
`.env` holds your database password - it is git-ignored; never share or commit it. Use the **pooled** connection string from Neon.

## Frontend (only if you edit the React code)
    cd frontend && npm install && npm run build        # dev: npm run dev (backend must be running on :8000)

## Adding a new test type
Write the function in `backend/runner.py`, add its key to the `TESTS` dict, use that key in the TEST_KEY column.
