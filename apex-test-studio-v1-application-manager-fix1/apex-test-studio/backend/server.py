"""APEX Test Studio backend - everything is stored in PostgreSQL (see db.py).

POST /api/upload?filename=x.xlsx   raw workbook -> saved in DB, returns parsed test cases
GET  /api/uploads                  recent workbooks (re-run without re-uploading)
GET  /api/uploads/<id>             one stored workbook's cases
POST /api/runs  {upload_id, ...}   start a run in the background (one at a time)
GET  /api/runs                     run history        GET /api/runs/<id>   live status + results
DELETE /api/runs/<id>              delete a finished run (and its videos)
GET  /api/runs/<id>/report         self-contained HTML report   GET /api/runs/<id>/csv
GET/POST /api/custom, PUT/DELETE /api/custom/<id>   tests built in the UI (stored in the DB)
GET/POST /api/applications, PUT/DELETE /api/applications/<id>   the Application Manager
POST /api/applications/test {base_url}   Test Connection (is the URL reachable?)
GET  /api/analytics                trend + most-failing tests    GET/PUT /api/settings
GET  /media/<media_id>             video / screenshot streamed from the DB (Range supported -> seeking works)
GET  /                             the built React app (frontend/dist)

Start:   python server.py            (http://localhost:8000)
Preview: DEMO=1 python server.py     (simulated results + real recorded videos, still stored in the DB)
"""
import csv
import html
import io
import json
import mimetypes
import os
import re
import shutil
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

import psycopg

import db
import runner

ROOT = Path(__file__).resolve().parent
DIST = ROOT.parent / "frontend" / "dist"
DEMO = os.environ.get("DEMO", "").strip().lower() in ("1", "y", "yes", "true")
PORT = int(os.environ.get("PORT", "8000"))
RUN_LOCK = threading.Lock()          # runner.py keeps module-level state -> one run at a time
MIME = {".webm": "video/webm", ".png": "image/png"}


def _json_default(o):
    return o.isoformat() if hasattr(o, "isoformat") else str(o)


def describe_cases(path):
    cases = runner.load_cases(path)
    return [dict(id=c["_CASE_ID"], name=c["_LABEL"], key=str(c.get("TEST_KEY") or ""),
                 expected=str(c.get("EXPECTED_RESULT") or ""), data=c.get("TEST_DATA"),
                 implemented=str(c.get("TEST_KEY") or "").strip().upper() in runner.TESTS) for c in cases]


def custom_id(r):
    return f"CUS-{r['id']:03d}"


def custom_desc(r):
    """Shape sent to the UI."""
    p = r["params"] or {}
    return dict(id=custom_id(r), db_id=r["id"], name=r["name"], key=r["test_key"], expected=r["expected"] or "",
                data=p.get("data"), custom=True, implemented=True, params=p, steps=r["steps"])


def custom_case(r):
    """Shape the runner executes (same keys an Excel row would have)."""
    p, cid = r["params"] or {}, custom_id(r)
    return {"TEST_CASE_ID": cid, "_CASE_ID": cid, "TEST_NAME": r["name"], "_LABEL": r["name"], "TEST_KEY": r["test_key"],
            "EXPECTED_RESULT": r["expected"] or "", "TEST_DATA": p.get("data") or None, "WEEK_OFFSET": p.get("week_offset"),
            "DATE_OFFSET_DAYS": p.get("date_offset"), "DAY": p.get("day"), "STEPS": r["steps"]}


def clean_custom(body):
    name = str(body.get("name") or "").strip()
    if not name:
        raise ValueError("Give the test a name.")
    key = str(body.get("test_key") or "CUSTOM_STEPS").strip().upper()
    if key not in runner.TESTS:
        raise ValueError(f"Unknown test type {key}.")
    steps = []
    for st in body.get("steps") or []:
        act = str(st.get("action") or "")
        if act not in runner.STEP_LABELS:
            raise ValueError(f"Unknown step action '{act}'.")
        steps.append({"action": act, "target": str(st.get("target") or "").strip(), "value": str(st.get("value") or "").strip()})
    if key == "CUSTOM_STEPS" and not steps:
        raise ValueError("Add at least one step.")
    params = {k: v for k, v in (body.get("params") or {}).items() if k in ("data", "week_offset", "date_offset", "day") and str(v).strip() != ""}
    return name, str(body.get("expected") or "").strip(), key, params, steps


ENVIRONMENTS = ("development", "test", "staging")
AUTH_TYPES = ("chrome_session",)        # username/password login arrives with the Test Users feature


def clean_app(body):
    name = str(body.get("name") or "").strip()
    if not name:
        raise ValueError("Give the application a name.")
    if len(name) > 80:
        raise ValueError("Application name is too long (max 80 characters).")
    url = str(body.get("base_url") or "").strip().rstrip("/")
    if not re.match(r"https?://\S+$", url):
        raise ValueError("Base URL must start with http:// or https:// (no spaces).")
    env = str(body.get("environment") or "test").strip().lower()
    if env not in ENVIRONMENTS:
        raise ValueError("Environment must be development, test or staging.")
    auth = str(body.get("auth_type") or "chrome_session").strip()
    if auth not in AUTH_TYPES:
        raise ValueError("Unsupported authentication type.")
    return name, url, env, auth, str(body.get("description") or "").strip()[:300]


def check_url(url):
    """Test Connection: any HTTP answer (even 302/401/403) means the server is reachable; 5xx or no answer is a problem."""
    if not re.match(r"https?://\S+$", url or ""):
        return dict(ok=False, error="Base URL must start with http:// or https://")
    req = urllib.request.Request(url, headers={"User-Agent": "APEX-Test-Studio/1.0"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            status, final = resp.status, resp.geturl()
    except urllib.error.HTTPError as exc:               # the server answered, just not with 2xx
        status, final = exc.code, exc.geturl()
    except Exception as exc:
        return dict(ok=False, error=str(getattr(exc, "reason", None) or exc)[:200])
    ms = int((time.time() - t0) * 1000)
    note = ("Reachable." if status < 400 else
            "Reachable (the app asks for a login, which is normal)." if status in (401, 403) else
            f"The server answered with HTTP {status}." )
    return dict(ok=status < 500, status=status, ms=ms, final_url=final, note=note)


def with_temp_xlsx(data, fn):
    """The runner reads Excel from a path: give it a throw-away temp file (deleted immediately)."""
    tmp = Path(tempfile.mkdtemp(prefix="ats_x_"))
    try:
        p = tmp / "tests.xlsx"
        p.write_bytes(data)
        return fn(p)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------------------ demo mode (no APEX needed)
def demo_run(excel_path, out, on_event, only=None, extra=None):
    """Simulates a run: records a real short video per case so the UI can be previewed end to end."""
    from playwright.sync_api import sync_playwright
    cases = runner.select_cases(runner.load_cases(excel_path) if excel_path else [], only, extra)
    on_event("cases", [dict(id=c["_CASE_ID"], name=c["_LABEL"], key=str(c.get("TEST_KEY") or ""),
                            expected=str(c.get("EXPECTED_RESULT") or ""), data=c.get("TEST_DATA")) for c in cases])
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for i, c in enumerate(cases):
            cid = c["_CASE_ID"]
            on_event("start", cid)
            fail = i % 3 == 2
            vdir = out / "tmp"
            ctx = browser.new_context(viewport={"width": 960, "height": 540}, record_video_dir=str(vdir),
                                      record_video_size={"width": 960, "height": 540})
            page = ctx.new_page()
            page.set_content(f"<body style='font-family:sans-serif;padding:48px'><h2>DEMO - {cid}</h2>"
                             f"<p>{c['_LABEL']}</p><div id=b style='height:14px;width:0;background:"
                             f"{'#dc2626' if fail else '#16a34a'};transition:width 2s'></div></body>")
            page.wait_for_timeout(200)
            page.evaluate("document.getElementById('b').style.width='100%'")
            page.wait_for_timeout(2300)
            ctx.close()
            safe = re.sub(r"[^A-Za-z0-9_-]+", "_", cid)
            vids = list(vdir.glob("*.webm"))
            vids[0].replace(out / f"{safe}.webm")
            on_event("done", dict(test_case_id=cid, name=c["_LABEL"], test_key=str(c.get("TEST_KEY") or ""),
                                  expected=str(c.get("EXPECTED_RESULT") or ""), status="FAIL" if fail else "PASS", secs=2.5,
                                  detail=("Demo: simulated failure - the cell was still editable." if fail
                                          else "Demo: simulated pass - behaved as expected."),
                                  video=f"{safe}.webm", shot="", data=c.get("TEST_DATA")))
        browser.close()


# ------------------------------------------------------------------ run worker: evidence goes straight into PostgreSQL
def worker(run_id, upload_id, req, only, extra):
    tmp = Path(tempfile.mkdtemp(prefix="ats_run_"))         # Playwright needs a folder while recording; wiped at the end
    out = tmp / "out"
    state = {"order": []}

    def store_file(case_id, kind, rel):
        if not rel:
            return None
        f = out / str(rel).replace("\\", "/")
        if not f.is_file():
            return None
        try:
            return db.add_media(run_id, case_id, kind, f.name,
                                MIME.get(f.suffix.lower(), "application/octet-stream"), f.read_bytes())
        finally:
            f.unlink(missing_ok=True)                      # nothing is left on disk

    def on_event(kind, payload):
        try:
            if kind == "cases":
                state["order"] = [c["id"] for c in payload]
                db.update_run(run_id, cases=payload)
            elif kind == "start":
                db.update_run(run_id, current_case=payload)
            elif kind == "done":
                r = dict(payload)
                cid = r["test_case_id"]
                vid = store_file(cid, "video", r.get("video"))
                shot = store_file(cid, "screenshot", r.get("shot"))
                seq = state["order"].index(cid) if cid in state["order"] else len(state["order"])
                db.add_result(run_id, seq, r, vid, shot)
                db.update_run(run_id, current_case=None)
        except Exception:
            traceback.print_exc()

    status, error = "finished", None
    try:
        with RUN_LOCK:
            xlsx = None
            if upload_id:
                up = db.get_upload(upload_id, with_content=True)
                xlsx = tmp / "tests.xlsx"
                xlsx.write_bytes(bytes(up["content"]))
            if DEMO:
                demo_run(xlsx, out, on_event, only, extra)
            else:
                runner.run_job(xlsx, out, req["base_url"], req.get("cdp_url") or "http://127.0.0.1:9222",
                               bool(req.get("allow_save")), bool(req.get("headless")),
                               int(req.get("slow_mo") if req.get("slow_mo") is not None else 60),
                               only=only, on_event=on_event, extra_cases=extra)
    except Exception as exc:
        traceback.print_exc()
        status, error = "error", str(exc)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    try:
        db.update_run(run_id, status=status, error=error, current_case=None, finished=True)
        db.prune()
    except Exception:
        traceback.print_exc()


# ------------------------------------------------------------------ reports (rendered from the DB)
def render_report(run):
    rows = []
    colors = {"PASS": "#15803d", "FAIL": "#b91c1c", "SKIP": "#b45309"}
    esc = lambda v: html.escape(str(v if v is not None else ""))
    for r in db.run_rows_for_export(run["id"]):
        vid = f'<a href="/media/{r["video_id"]}" target="_blank">Watch</a>' if r["video_id"] else "-"
        shot = f'<a href="/media/{r["shot_id"]}" target="_blank">Screenshot</a>' if r["shot_id"] else "-"
        rows.append(f"<tr><td>{esc(r['test_case_id'])}</td><td>{esc(r['name'])}</td><td>{esc(r['data'])}</td>"
                    f"<td>{esc(r['expected'])}</td><td style='color:{colors.get(r['status'], '#000')};font-weight:700'>"
                    f"{esc(r['status'])}</td><td>{esc(r['detail'])}</td><td>{shot}</td><td>{vid}</td></tr>")
    counts = {s: sum(1 for r in run["results"].values() if r["status"] == s) for s in ("PASS", "FAIL", "SKIP")}
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>Test report {run['id']}</title>
<style>body{{font-family:system-ui,Arial,sans-serif;margin:28px;color:#0f172a}}table{{border-collapse:collapse;width:100%}}
td,th{{border:1px solid #e2e8f0;padding:9px;text-align:left;vertical-align:top;font-size:14px}}th{{background:#0f172a;color:#fff}}
tr:nth-child(even){{background:#f8fafc}}h2{{margin:0 0 4px}}</style></head><body>
<h2>APEX Test Studio - run {esc(run['id'])}</h2><p>{esc(run.get('application_name') or '')} | {esc(run.get('filename'))} | Total {len(run['results'])} |
PASS {counts['PASS']} | FAIL {counts['FAIL']} | SKIP {counts['SKIP']}</p>
<table><tr><th>ID</th><th>Test case</th><th>Sample</th><th>Expected</th><th>Status</th><th>Actual / details</th><th>Screenshot</th><th>Video</th></tr>
{''.join(rows)}</table></body></html>"""


def render_csv(run_id):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["test_case_id", "name", "test_key", "data", "expected", "status", "detail", "secs"])
    for r in db.run_rows_for_export(run_id):
        w.writerow([r["test_case_id"], r["name"], r["test_key"], r["data"], r["expected"], r["status"], r["detail"], r["secs"]])
    return ("\ufeff" + buf.getvalue()).encode("utf-8")


# ------------------------------------------------------------------ HTTP
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def send_json(self, obj, status=200):
        body = json.dumps(obj, default=_json_default).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, data, ctype, extra=None):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def error(self, status, msg):
        self.send_json({"error": msg}, status)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in (("Access-Control-Allow-Origin", "*"), ("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS"),
                     ("Access-Control-Allow-Headers", "Content-Type"), ("Content-Length", "0")):
            self.send_header(k, v)
        self.end_headers()

    def read_body(self):
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    # ---- POST / PUT / DELETE
    def do_POST(self):
        url = urlparse(self.path)
        try:
            if url.path == "/api/upload":
                qs = parse_qs(url.query)
                return self.upload(qs.get("filename", ["tests.xlsx"])[0], qs.get("application_id", [""])[0])
            if url.path == "/api/runs":
                return self.start_run()
            if url.path == "/api/custom":
                return self.save_custom(None)
            if url.path == "/api/applications/test":
                body = json.loads(self.read_body() or b"{}")
                return self.send_json(check_url(str(body.get("base_url") or "").strip()))
            if url.path == "/api/applications":
                return self.save_app(None)
            self.error(404, "Not found")
        except Exception as exc:
            traceback.print_exc()
            self.error(500, str(exc))

    def do_PUT(self):
        try:
            path = urlparse(self.path).path
            if path == "/api/settings":
                db.save_settings(json.loads(self.read_body() or b"{}"))
                return self.send_json({"ok": True})
            m = re.fullmatch(r"/api/custom/(\d+)", path)
            if m:
                return self.save_custom(int(m.group(1)))
            m = re.fullmatch(r"/api/applications/(\d+)", path)
            if m:
                return self.save_app(int(m.group(1)))
            self.error(404, "Not found")
        except Exception as exc:
            self.error(500, str(exc))

    def save_app(self, app_id):
        try:
            name, url, env, auth, desc = clean_app(json.loads(self.read_body() or b"{}"))
        except ValueError as exc:
            return self.error(400, str(exc))
        try:
            new_id = db.save_application(app_id, name, url, env, auth, desc)
        except psycopg.errors.UniqueViolation:
            return self.error(409, f"An application named '{name}' already exists.")
        if not new_id:
            return self.error(404, "Application not found.")
        self.send_json(next(a for a in db.list_applications() if a["id"] == new_id))

    def save_custom(self, cid):
        body = json.loads(self.read_body() or b"{}")
        try:
            name, expected, key, params, steps = clean_custom(body)
        except ValueError as exc:
            return self.error(400, str(exc))
        app_id = None
        if not cid:                                      # a new test belongs to the application it was created in
            try:
                app_id = int(body.get("application_id"))
            except (TypeError, ValueError):
                return self.error(400, "Choose an application first.")
            if not db.get_application(app_id):
                return self.error(404, "Application not found.")
        new_id = db.save_custom(cid, name, expected, key, params, steps, app_id)
        if not new_id:
            return self.error(404, "Test not found.")
        row = next(r for r in db.list_custom() if r["id"] == new_id)
        self.send_json(custom_desc(row))

    def do_DELETE(self):
        path = unquote(urlparse(self.path).path)
        m = re.fullmatch(r"/api/applications/(\d+)", path)
        if m:
            try:
                app_id = int(m.group(1))
                if db.q1("select 1 as x from ats_runs where status='running' and application_id=%s", (app_id,)):
                    return self.error(409, "A run for this application is in progress. Wait for it to finish.")
                if len(db.list_applications()) <= 1:
                    return self.error(409, "You need at least one application. Create another one before deleting this one.")
                n = db.delete_application(app_id)
                return self.send_json({"deleted": n}) if n else self.error(404, "Application not found.")
            except Exception as exc:
                return self.error(500, str(exc))
        m = re.fullmatch(r"/api/custom/(\d+)", path)
        if m:
            try:
                db.delete_custom(int(m.group(1)))
                return self.send_json({"deleted": 1})
            except Exception as exc:
                return self.error(500, str(exc))
        m = re.fullmatch(r"/api/runs/([\w-]+)", path)
        try:
            if not m:
                return self.error(404, "Not found")
            n = db.delete_run(m.group(1))
            return self.send_json({"deleted": n}) if n else self.error(409, "Run not found or still running.")
        except Exception as exc:
            self.error(500, str(exc))

    def upload(self, filename, application_id=""):
        data = self.read_body()
        if not (application_id.isdigit() and db.get_application(int(application_id))):
            return self.error(400, "Choose an application before uploading a workbook.")
        if not filename.lower().endswith((".xlsx", ".xlsm")):
            return self.error(400, "Please upload an Excel workbook (.xlsx).")
        try:
            with RUN_LOCK:
                cases = with_temp_xlsx(data, describe_cases)
        except Exception as exc:
            return self.error(400, f"Could not read the workbook: {exc}")
        if not cases:
            return self.error(400, "No enabled test cases found. Set ENABLED = Y in the Test_Cases sheet.")
        upload_id = db.save_upload(filename, data, cases, int(application_id))
        self.send_json(dict(upload_id=upload_id, filename=filename, cases=cases,
                            unsupported=[c["id"] for c in cases if not c["implemented"]]))

    def start_run(self):
        req = json.loads(self.read_body() or b"{}")
        try:
            app = db.get_application(int(req.get("application_id")))
        except (TypeError, ValueError):
            app = None
        if not app:
            return self.error(400, "Choose an application to test (Applications tab).")
        up = None
        if req.get("upload_id"):
            up = db.get_upload(req["upload_id"])
            if not up:
                return self.error(404, "Upload not found - upload the Excel file again.")
            if up["application_id"] != app["id"]:
                return self.error(400, "That workbook belongs to a different application.")
        req["base_url"] = app["base_url"]                # the URL always comes from the application, not from the browser
        if not DEMO and not str(app["base_url"]).startswith("http"):
            return self.error(400, f"'{app['name']}' has no Base URL yet. Edit the application and add it.")
        if db.q1("select 1 as x from ats_runs where status='running' limit 1"):
            return self.error(409, "A run is already in progress.")
        only = req.get("only")                                  # ids picked in the UI; None = everything
        wanted = None if only is None else {str(i) for i in only}
        excel = list(up["cases"]) if up else []
        customs = db.list_custom(app["id"])
        if wanted is not None:
            excel = [c for c in excel if c["id"] in wanted]
            customs = [c for c in customs if custom_id(c) in wanted]
        descs = excel + [custom_desc(c) for c in customs]
        if not descs:
            return self.error(400, "Select at least one test case to run.")
        run_id = datetime.now().strftime("%Y%m%d-%H%M%S")
        safe_settings = {k: req.get(k) for k in ("cdp_url", "allow_save", "headless", "slow_mo")}
        db.create_run(run_id, up["id"] if up else None, up["filename"] if up else "Custom tests", DEMO,
                      req.get("base_url", ""), safe_settings, app["id"], app["name"])
        db.update_run(run_id, cases=descs)
        threading.Thread(target=worker, args=(run_id, up["id"] if up else None, req,
                                              None if wanted is None else sorted(wanted),
                                              [custom_case(c) for c in customs]), daemon=True).start()
        self.send_json(dict(run_id=run_id))

    # ---- GET
    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        try:
            if path == "/api/config":
                info = dict(demo=DEMO, default_base_url=os.environ.get("APEX_BASE", ""), db=None, db_error=None)
                try:
                    info["db"] = {**db.ping(), **db.storage()}
                except Exception as exc:
                    info["db_error"] = str(exc).splitlines()[0][:200]
                return self.send_json(info)
            if path == "/api/settings":
                return self.send_json(db.get_settings())
            qs = parse_qs(urlparse(self.path).query)
            app_filter = int(qs["application_id"][0]) if qs.get("application_id", [""])[0].isdigit() else None
            if path == "/api/applications":
                return self.send_json(db.list_applications())
            if path == "/api/uploads":
                return self.send_json(db.list_uploads(application_id=app_filter))
            if path == "/api/custom":
                return self.send_json([custom_desc(r) for r in db.list_custom(app_filter)])
            m = re.fullmatch(r"/api/uploads/([\w-]+)", path)
            if m:
                up = db.get_upload(m.group(1))
                if not up:
                    return self.error(404, "Unknown workbook")
                return self.send_json(dict(upload_id=up["id"], filename=up["filename"], cases=up["cases"],
                                           unsupported=[c["id"] for c in up["cases"] if not c.get("implemented")]))
            if path == "/api/runs":
                return self.send_json(db.list_runs(application_id=app_filter))
            if path == "/api/analytics":
                return self.send_json(db.analytics(app_filter))
            m = re.fullmatch(r"/api/runs/([\w-]+)(?:/(report|csv))?", path)
            if m:
                run = db.get_run(m.group(1))
                if not run:
                    return self.error(404, "Unknown run")
                if m.group(2) == "report":
                    return self.send_bytes(render_report(run).encode("utf-8"), "text/html; charset=utf-8")
                if m.group(2) == "csv":
                    return self.send_bytes(render_csv(run["id"]), "text/csv; charset=utf-8",
                                           {"Content-Disposition": f'attachment; filename="run_{run["id"]}.csv"'})
                return self.send_json(run)
            m = re.fullmatch(r"/media/(\d+)", path)
            if m:
                return self.serve_media(int(m.group(1)))
        except Exception as exc:
            traceback.print_exc()
            return self.error(500, str(exc))
        if DIST.exists():
            return self.serve_file(DIST, path.lstrip("/") or "index.html", spa=True)
        self.error(404, "Frontend not built yet. Run 'npm run build' in /frontend (or 'npm run dev').")

    def serve_media(self, media_id):
        info = db.media_info(media_id)
        if not info:
            return self.error(404, "Not found")
        size = info["size_bytes"] or 0
        start, end, status = 0, size - 1, 200
        rng = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if rng and (rng.group(1) or rng.group(2)):
            if rng.group(1):
                start = int(rng.group(1))
                end = int(rng.group(2)) if rng.group(2) else size - 1
            else:
                start = max(0, size - int(rng.group(2)))
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                return self.end_headers()
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", info["mime"] or "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "private, max-age=3600")
        self.send_header("Content-Disposition", f'inline; filename="{info["filename"]}"')
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        try:
            pos, left = start, end - start + 1
            while left > 0:                                    # stream in 1 MB pieces straight from PostgreSQL
                chunk = db.media_slice(media_id, pos, min(1 << 20, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                pos += len(chunk)
                left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def serve_file(self, base, rel, spa=False):
        f = (base / rel).resolve()
        if base.resolve() not in f.parents and f != base.resolve():
            return self.error(403, "Forbidden")
        if not f.is_file():
            if spa and not Path(rel).suffix:
                f = base / "index.html"
            else:
                return self.error(404, "Not found")
        self.send_bytes(f.read_bytes(), mimetypes.guess_type(f.name)[0] or "application/octet-stream")


if __name__ == "__main__":
    if not db.configured():
        raise SystemExit("DATABASE_URL is missing. Create backend/.env from .env.example (PostgreSQL connection string).")
    print("Connecting to PostgreSQL ...")
    db.init()
    print("Database ready:", db.ping()["database"])
    print(f"APEX Test Studio on http://localhost:{PORT}" + ("  [DEMO MODE - simulated results]" if DEMO else ""))
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
