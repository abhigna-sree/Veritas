"""PostgreSQL storage for APEX Test Studio (works with Neon, Supabase, or any Postgres).

EVERYTHING lives in the database: uploaded workbooks, runs, per-test results, videos, screenshots, settings.
Nothing is written to local disk except a throw-away temp folder while Playwright records (deleted after each test).

Connection: DATABASE_URL in backend/.env  (or a real environment variable).
Neon's pooled endpoint runs PgBouncer in transaction mode, so prepared statements are switched off.
"""
import os
import uuid
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

KEEP_RUNS = int(os.environ.get("KEEP_RUNS", "8"))          # newest runs kept (videos are large; Neon free tier = 0.5 GB)
KEEP_UPLOADS = int(os.environ.get("KEEP_UPLOADS", "15"))
FREE_TIER_MB = int(os.environ.get("DB_LIMIT_MB", "512"))   # only used for the storage meter in the UI


def _load_env():
    """Tiny .env reader (no python-dotenv needed). Real environment variables win."""
    for p in (Path(__file__).resolve().parent / ".env", Path.cwd() / ".env"):
        if p.is_file():
            for line in p.read_text(encoding="utf-8-sig").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
            break


_load_env()
URL = os.environ.get("DATABASE_URL", "").strip()
_pool = None

SCHEMA = [
    """create table if not exists ats_registered_apps (
         id serial primary key, name text not null unique, base_url text not null default '',
         environment text not null default 'test', auth_type text not null default 'chrome_session',
         description text not null default '',
         created_at timestamptz not null default now(), updated_at timestamptz not null default now())""",
    """create table if not exists ats_settings (
         key text primary key, value jsonb not null, updated_at timestamptz not null default now())""",
    """create table if not exists ats_uploads (
         id text primary key, filename text not null, content bytea not null, size_bytes integer,
         cases jsonb not null default '[]', created_at timestamptz not null default now())""",
    """create table if not exists ats_runs (
         id text primary key,
         upload_id text references ats_uploads(id) on delete set null,
         filename text, status text not null default 'running', demo boolean not null default false,
         base_url text, settings jsonb not null default '{}', cases jsonb not null default '[]',
         current_case text, error text,
         started_at timestamptz not null default now(), finished_at timestamptz)""",
    """create table if not exists ats_media (
         id bigserial primary key,
         run_id text not null references ats_runs(id) on delete cascade,
         test_case_id text, kind text not null, filename text, mime text,
         size_bytes integer, content bytea not null, created_at timestamptz not null default now())""",
    """create index if not exists ats_media_run_idx on ats_media (run_id)""",
    """create table if not exists ats_custom_tests (
         id serial primary key, name text not null, expected text,
         test_key text not null default 'CUSTOM_STEPS',
         params jsonb not null default '{}', steps jsonb not null default '[]',
         created_at timestamptz not null default now(), updated_at timestamptz not null default now())""",
    """create table if not exists ats_results (
         run_id text not null references ats_runs(id) on delete cascade,
         test_case_id text not null, seq integer, name text, test_key text, expected text, data text,
         status text not null, detail text, secs double precision,
         video_id bigint references ats_media(id) on delete set null,
         shot_id bigint references ats_media(id) on delete set null,
         created_at timestamptz not null default now(),
         primary key (run_id, test_case_id))""",
    # --- Feature 1: everything belongs to an application
    "alter table ats_uploads add column if not exists application_id integer references ats_registered_apps(id) on delete cascade",
    "alter table ats_custom_tests add column if not exists application_id integer references ats_registered_apps(id) on delete cascade",
    "alter table ats_runs add column if not exists application_id integer references ats_registered_apps(id) on delete set null",
    "alter table ats_runs add column if not exists application_name text",
]


# ------------------------------------------------------------------ connection
def configured():
    return bool(URL)


def pool():
    global _pool
    if _pool is None:
        if not URL:
            raise RuntimeError("DATABASE_URL is not set. Put it in backend/.env (see .env.example).")
        _pool = ConnectionPool(
            URL, min_size=1, max_size=8, open=False, timeout=45,
            kwargs=dict(autocommit=True, row_factory=dict_row, prepare_threshold=None, connect_timeout=30),
            check=ConnectionPool.check_connection,      # Neon suspends idle computes - drop dead connections
        )
        _pool.open(wait=True, timeout=60)
    return _pool


def q(sql, params=None):
    with pool().connection() as c:
        return c.execute(sql, params).fetchall()


def q1(sql, params=None):
    rows = q(sql, params)
    return rows[0] if rows else None


def x(sql, params=None):
    with pool().connection() as c:
        return c.execute(sql, params).rowcount


def init():
    with pool().connection() as c:
        for stmt in SCHEMA:
            c.execute(stmt)
        # a server restart kills any in-flight run
        c.execute("""update ats_runs set status='error', finished_at=now(),
                     error='The server restarted while this run was in progress.' where status='running'""")
    seed_default_application()


def seed_default_application():
    """First start after the upgrade: register the existing Timesheet app and attach all existing data to it."""
    if q1("select 1 as x from ats_registered_apps limit 1"):
        return
    base = (os.environ.get("APEX_BASE", "").strip() or str(get_settings().get("baseUrl") or "").strip()).rstrip("/")
    row = q1("insert into ats_registered_apps(name, base_url, environment, description) values (%s,%s,'test',%s) returning id",
             ("Timesheet App", base, "Oracle APEX timesheet application (registered automatically)"))
    x("update ats_uploads set application_id=%s where application_id is null", (row["id"],))
    x("update ats_custom_tests set application_id=%s where application_id is null", (row["id"],))
    x("update ats_runs set application_id=%s, application_name='Timesheet App' where application_id is null", (row["id"],))


def ping():
    row = q1("select current_database() as db, version() as v")
    return dict(database=row["db"], version=row["v"].split(",")[0])


# ------------------------------------------------------------------ settings
def get_settings():
    row = q1("select value from ats_settings where key='ui'")
    return row["value"] if row else {}


def save_settings(value):
    x("""insert into ats_settings(key, value) values ('ui', %s)
         on conflict (key) do update set value = excluded.value, updated_at = now()""", (Jsonb(value),))


# ------------------------------------------------------------------ applications
def list_applications():
    return q("""select a.*,
                  (select count(*) from ats_custom_tests t where t.application_id = a.id) as tests,
                  (select count(*) from ats_uploads u where u.application_id = a.id) as workbooks,
                  (select count(*) from ats_runs r where r.application_id = a.id) as runs,
                  (select row_to_json(l) from (
                      select r.id, r.status, r.started_at, count(s.test_case_id) as total,
                             count(*) filter (where s.status='PASS') as pass
                      from ats_runs r left join ats_results s on s.run_id = r.id
                      where r.application_id = a.id group by r.id order by r.started_at desc limit 1) l) as last_run
                from ats_registered_apps a order by a.id""")


def get_application(app_id):
    return q1("select * from ats_registered_apps where id=%s", (app_id,))


def save_application(app_id, name, base_url, environment, auth_type, description):
    if app_id:
        row = q1("""update ats_registered_apps set name=%s, base_url=%s, environment=%s, auth_type=%s, description=%s,
                    updated_at=now() where id=%s returning id""",
                 (name, base_url, environment, auth_type, description, app_id))
        if row:                                         # keep the app name on old runs in sync
            x("update ats_runs set application_name=%s where application_id=%s", (name, app_id))
    else:
        row = q1("""insert into ats_registered_apps(name, base_url, environment, auth_type, description)
                    values (%s,%s,%s,%s,%s) returning id""", (name, base_url, environment, auth_type, description))
    return row["id"] if row else None


def delete_application(app_id):
    """Its tests and workbooks go with it; run history stays (it keeps the application name)."""
    return x("delete from ats_registered_apps where id=%s", (app_id,))


# ------------------------------------------------------------------ custom tests (built in the UI)
def list_custom(application_id=None):
    if application_id:
        return q("select id, name, expected, test_key, params, steps, created_at, application_id from ats_custom_tests "
                 "where application_id=%s order by id", (application_id,))
    return q("select id, name, expected, test_key, params, steps, created_at, application_id from ats_custom_tests order by id")


def save_custom(cid, name, expected, test_key, params, steps, application_id=None):
    if cid:
        row = q1("""update ats_custom_tests set name=%s, expected=%s, test_key=%s, params=%s, steps=%s, updated_at=now()
                    where id=%s returning id""", (name, expected, test_key, Jsonb(params), Jsonb(steps), cid))
    else:
        row = q1("""insert into ats_custom_tests(name, expected, test_key, params, steps, application_id)
                    values (%s,%s,%s,%s,%s,%s) returning id""",
                 (name, expected, test_key, Jsonb(params), Jsonb(steps), application_id))
    return row["id"] if row else None


def delete_custom(cid):
    return x("delete from ats_custom_tests where id=%s", (cid,))


# ------------------------------------------------------------------ uploads
def save_upload(filename, data, cases, application_id=None):
    uid = uuid.uuid4().hex[:10]
    x("insert into ats_uploads(id, filename, content, size_bytes, cases, application_id) values (%s,%s,%s,%s,%s,%s)",
      (uid, filename, data, len(data), Jsonb(cases), application_id))
    x("""delete from ats_uploads where id not in (select id from ats_uploads order by created_at desc limit %s)
         and id not in (select upload_id from ats_runs where upload_id is not null)""", (KEEP_UPLOADS,))
    return uid


def get_upload(uid, with_content=False):
    cols = "id, filename, size_bytes, cases, created_at, application_id" + (", content" if with_content else "")
    return q1(f"select {cols} from ats_uploads where id=%s", (uid,))


def list_uploads(limit=6, application_id=None):
    if application_id:
        return q("select id, filename, size_bytes, jsonb_array_length(cases) as n, created_at from ats_uploads "
                 "where application_id=%s order by created_at desc limit %s", (application_id, limit))
    return q("select id, filename, size_bytes, jsonb_array_length(cases) as n, created_at "
             "from ats_uploads order by created_at desc limit %s", (limit,))


# ------------------------------------------------------------------ runs / results / media
def create_run(run_id, upload_id, filename, demo, base_url, settings, application_id=None, application_name=None):
    x("""insert into ats_runs(id, upload_id, filename, demo, base_url, settings, application_id, application_name)
         values (%s,%s,%s,%s,%s,%s,%s,%s)""",
      (run_id, upload_id, filename, demo, base_url, Jsonb(settings), application_id, application_name))


def update_run(run_id, **fields):
    if not fields:
        return
    sets, vals = [], []
    for k, v in fields.items():
        if k == "finished":
            sets.append("finished_at = now()")
            continue
        sets.append(f"{k} = %s")
        vals.append(Jsonb(v) if k in ("cases", "settings") else v)
    x(f"update ats_runs set {', '.join(sets)} where id=%s", (*vals, run_id))


def add_media(run_id, case_id, kind, filename, mime, data):
    row = q1("insert into ats_media(run_id, test_case_id, kind, filename, mime, size_bytes, content) "
             "values (%s,%s,%s,%s,%s,%s,%s) returning id", (run_id, case_id, kind, filename, mime, len(data), data))
    return row["id"]


def add_result(run_id, seq, r, video_id=None, shot_id=None):
    x("""insert into ats_results(run_id, test_case_id, seq, name, test_key, expected, data, status, detail, secs, video_id, shot_id)
         values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
         on conflict (run_id, test_case_id) do update set status=excluded.status, detail=excluded.detail,
           secs=excluded.secs, video_id=excluded.video_id, shot_id=excluded.shot_id""",
      (run_id, r["test_case_id"], seq, r.get("name"), r.get("test_key"), r.get("expected"),
       None if r.get("data") is None else str(r.get("data")), r["status"], r.get("detail"),
       float(r.get("secs") or 0), video_id, shot_id))


def prune():
    x("delete from ats_runs where id not in (select id from ats_runs order by started_at desc limit %s)", (KEEP_RUNS,))


def _media_url(i):
    return f"/media/{i}" if i else None


def get_run(run_id):
    run = q1("select * from ats_runs where id=%s", (run_id,))
    if not run:
        return None
    rows = q("select test_case_id, seq, name, test_key, expected, data, status, detail, secs, video_id, shot_id "
             "from ats_results where run_id=%s order by seq", (run_id,))
    prev = q1("select id from ats_runs where started_at < %s and status='finished' and demo=%s and id<>%s "
              "and application_id is not distinct from %s order by started_at desc limit 1",
              (run["started_at"], run["demo"], run_id, run["application_id"]))
    prev_map = {}
    if prev:
        prev_map = {r["test_case_id"]: r["status"] for r in
                    q("select test_case_id, status from ats_results where run_id=%s", (prev["id"],))}
    results = {}
    for r in rows:
        results[r["test_case_id"]] = dict(
            test_case_id=r["test_case_id"], name=r["name"], test_key=r["test_key"], expected=r["expected"],
            data=r["data"], status=r["status"], detail=r["detail"], secs=round(r["secs"] or 0, 1),
            video=_media_url(r["video_id"]), shot=_media_url(r["shot_id"]), prev_status=prev_map.get(r["test_case_id"]))
    return dict(id=run["id"], status=run["status"], demo=run["demo"], filename=run["filename"], base_url=run["base_url"],
                application_id=run["application_id"], application_name=run["application_name"],
                cases=run["cases"], results=results, current=run["current_case"], error=run["error"],
                started_at=run["started_at"], finished_at=run["finished_at"], prev_run=prev["id"] if prev else None)


def list_runs(limit=25, application_id=None):
    return q("""select r.id, r.status, r.demo, r.filename, r.started_at, r.finished_at, r.application_id, r.application_name,
                       count(s.test_case_id) as total,
                       count(*) filter (where s.status='PASS') as pass,
                       count(*) filter (where s.status='FAIL') as fail,
                       count(*) filter (where s.status='SKIP') as skip,
                       coalesce(sum(s.secs),0)::float8 as secs
                from ats_runs r left join ats_results s on s.run_id = r.id
                where (%s::int is null or r.application_id = %s::int)
                group by r.id order by r.started_at desc limit %s""", (application_id, application_id, limit))


def delete_run(run_id):
    return x("delete from ats_runs where id=%s and status<>'running'", (run_id,))


def run_rows_for_export(run_id):
    return q("select test_case_id, name, test_key, data, expected, status, detail, secs, video_id, shot_id "
             "from ats_results where run_id=%s order by seq", (run_id,))


def analytics(application_id=None):
    trend = q("""select * from (
                   select r.id, r.started_at, r.demo,
                          count(*) filter (where s.status='PASS') as pass,
                          count(*) filter (where s.status='FAIL') as fail,
                          count(*) filter (where s.status='SKIP') as skip,
                          count(s.test_case_id) as total
                   from ats_runs r join ats_results s on s.run_id = r.id
                   where r.status in ('finished','error') and (%s::int is null or r.application_id = %s::int)
                   group by r.id order by r.started_at desc limit 14) t order by started_at""", (application_id, application_id))
    flaky = q("""select test_case_id, max(name) as name,
                        count(*) filter (where status='FAIL') as fails, count(*) as runs
                 from ats_results where run_id in (select id from ats_runs
                      where (%s::int is null or application_id = %s::int) order by started_at desc limit 14)
                 group by test_case_id having count(*) filter (where status='FAIL') > 0
                 order by fails desc, test_case_id limit 5""", (application_id, application_id))
    return dict(trend=trend, problem_tests=flaky)


def storage():
    s = q1("""select (select pg_database_size(current_database()))::float8 as db_bytes,
                     (select coalesce(sum(size_bytes),0) from ats_media)::float8 as media_bytes,
                     (select count(*) from ats_runs) as runs,
                     (select count(*) from ats_uploads) as uploads,
                     (select count(*) from ats_media) as media""")
    mb = lambda b: round(b / 1024 / 1024, 1)
    return dict(db_mb=mb(s["db_bytes"]), media_mb=mb(s["media_bytes"]), runs=s["runs"], uploads=s["uploads"],
                media=s["media"], limit_mb=FREE_TIER_MB)


# ------------------------------------------------------------------ media (range-aware, never loads a whole video at once)
def media_info(media_id):
    return q1("select id, kind, filename, mime, size_bytes from ats_media where id=%s", (media_id,))


def media_slice(media_id, start, length):
    row = q1("select substring(content from (%s)::int for (%s)::int) as part from ats_media where id=%s",
             (start + 1, length, media_id))                 # bytea substring is 1-based
    return bytes(row["part"]) if row and row["part"] is not None else b""
