import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api.js";

const DEFAULTS = { activeAppId: null, cdpUrl: "http://127.0.0.1:9222", allowSave: false, headless: false, slowMo: 60, theme: "dark" };
const ENV_LABEL = { development: "Development", test: "Test", staging: "Staging" };
const BLANK_APP = { id: null, name: "", base_url: "", environment: "test", auth_type: "chrome_session", description: "" };
const FILTERS = [["all", "All"], ["PASS", "Passed"], ["FAIL", "Failed"], ["SKIP", "Skipped"], ["REG", "Regressions"]];

/* what a user can pick when creating a test */
const ACTIONS = [
  { k: "open", label: "Open page", t: "Page alias or full URL", tph: "timesheet" },
  { k: "open_week", label: "Go to week", v: "Week offset", vph: "0 = this week, -1 = last week" },
  { k: "click", label: "Click", t: "Button, link, text or #selector", tph: "Save" },
  { k: "type", label: "Type into field", t: "Field label or #selector", tph: "Hours", v: "Text to type", vph: "8" },
  { k: "choose", label: "Choose option", t: "Field label or #selector", v: "Option text" },
  { k: "press", label: "Press key", v: "Key", vph: "Enter" },
  { k: "wait", label: "Wait (seconds)", v: "Seconds", vph: "2" },
  { k: "see", label: "Expect to see text", t: "Text that must be visible", tph: "Hours cannot be more than 24" },
  { k: "not_see", label: "Expect NOT to see text", t: "Text that must not be visible" },
  { k: "url", label: "Expect URL to contain", v: "Text", vph: "timesheet" },
];
const BUILTIN = [
  { key: "HOURS_ABOVE_24", label: "Hours above 24 are rejected", fields: [{ k: "data", label: "Hours to try", ph: "25" }] },
  { key: "NEGATIVE_HOURS", label: "Negative hours are rejected", fields: [{ k: "data", label: "Value to try", ph: "-1" }] },
  { key: "FUTURE_DATE_READONLY", label: "Future dates are read-only", fields: [{ k: "date_offset", label: "Days after today", ph: "1" }] },
  { key: "OLD_WEEK_READONLY", label: "Old weeks are read-only", fields: [{ k: "week_offset", label: "Week offset (-3 = three weeks back)", ph: "-3" }] },
  { key: "OLD_WEEK_BOUNDARY_EDITABLE", label: "Oldest allowed week is editable", fields: [{ k: "week_offset", label: "Week offset", ph: "-2" }] },
  { key: "WEEKEND_READONLY", label: "Weekend days are read-only", fields: [{ k: "day", label: "Day", options: ["Sat", "Sun"] }, { k: "week_offset", label: "Week offset", ph: "-1" }] },
  { key: "HOLIDAY_READONLY", label: "Holiday cell is not editable", fields: [{ k: "data", label: "Holiday date (optional, DD-Mon-YYYY)", ph: "02-Oct-2026" }] },
  { key: "ASSIGNED_ACTIVE_PROJECTS_ONLY", label: "Unassigned project is not selectable", fields: [{ k: "data", label: "Project that must NOT appear", ph: "Project name" }] },
  { key: "CROSS_EMPLOYEE_ACCESS_DENIED", label: "Another employee's data is not reachable", fields: [{ k: "data", label: "Other employee id", ph: "1" }] },
  { key: "OVERTIME_REQUIRES_APPROVAL", label: "Overtime needs approval", saves: true, fields: [{ k: "data", label: "Hours to save", ph: "9" }] },
  { key: "NORMAL_HOURS_APPROVED", label: "Normal hours are auto-approved", saves: true, fields: [{ k: "data", label: "Hours to save", ph: "8" }] },
  { key: "WEEKLY_LIMIT", label: "Weekly total above the limit is rejected", saves: true, fields: [{ k: "data", label: "Total hours to try", ph: "49" }] },
];

/* ------------------------------------------------------------------ helpers */
function useCountUp(target, ms = 500) {
  const [v, setV] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now(), a = from.current;
    let raf;
    const tick = (t) => {
      const p = Math.min((t - start) / ms, 1);
      setV(Math.round(a + (target - a) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick); else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}
const fmtDate = (s) => (s ? new Date(s).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
const pctOf = (r) => (r.total ? Math.round((r.pass / r.total) * 100) : 0);

const P = {
  upload: <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />,
  play: <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />,
  db: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  x: <path d="M18 6L6 18M6 6l12 12" />,
  trash: <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />,
  film: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />,
  up: <path d="M12 19V5M5 12l7-7 7 7" />,
  down: <path d="M12 5v14M5 12l7 7 7-7" />,
  back: <path d="M19 12H5M12 19l-7-7 7-7" />,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18" /></>,
  plug: <path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4" />,
};
const Svg = ({ name, size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{P[name]}</svg>
);

/* ------------------------------------------------------------------ app */
export default function App() {
  const [tab, setTab] = useState("studio");
  const [config, setConfig] = useState({ demo: false, db: null, db_error: null });
  const [settings, setSettings] = useState(DEFAULTS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [apps, setApps] = useState(null);                         // null = still loading
  const [showSettings, setShowSettings] = useState(false);
  const [upload, setUpload] = useState(null);
  const [custom, setCustom] = useState([]);
  const [recent, setRecent] = useState([]);
  const [skip, setSkip] = useState(() => new Set());           // ids the user un-ticked
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [run, setRun] = useState(null);
  const [filter, setFilter] = useState("all");
  const [watch, setWatch] = useState(null);
  const [builder, setBuilder] = useState(null);
  const [toasts, setToasts] = useState([]);
  const fileInput = useRef(null);

  const notify = useCallback((msg, kind = "ok") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "err" ? 7000 : 3500);
  }, []);

  // the application being tested: remembered in the database settings, falls back to the first one
  const activeApp = useMemo(() => apps?.find((a) => a.id === settings.activeAppId) || apps?.[0] || null, [apps, settings.activeAppId]);
  const appId = activeApp?.id;

  const loadApps = useCallback(() => api.listApps().then(setApps).catch(() => { setApps((a) => a || []); }), []);

  const refreshMeta = useCallback(() => {
    api.getConfig().then(setConfig).catch(() => notify("Cannot reach the backend. Start it with: python server.py", "err"));
    loadApps();
    if (appId) {
      api.listUploads(appId).then(setRecent).catch(() => {});
      api.listCustom(appId).then(setCustom).catch(() => {});
    }
  }, [notify, loadApps, appId]);

  useEffect(() => {
    api.getSettings().catch(() => ({})).then((s) => { setSettings({ ...DEFAULTS, ...s }); setSettingsLoaded(true); });
  }, []);
  useEffect(() => { refreshMeta(); }, [refreshMeta]);

  // switching application starts from a clean Studio (its own tests, workbooks and results)
  const prevApp = useRef(undefined);
  useEffect(() => {
    if (prevApp.current !== undefined && appId && prevApp.current !== appId) {
      setUpload(null); setSkip(new Set()); setRun(null); setCustom([]); setRecent([]);
    }
    if (appId) prevApp.current = appId;
  }, [appId]);

  // settings (including the theme) are stored in PostgreSQL, not in the browser
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    if (!settingsLoaded) return;
    const t = setTimeout(() => api.saveSettings(settings).catch(() => {}), 600);
    return () => clearTimeout(t);
  }, [settings, settingsLoaded]);

  const runId = run?.id;
  const running = run?.status === "running";
  useEffect(() => {
    if (!runId || !running) return;
    const t = setInterval(() => api.getRun(runId).then(setRun).catch(() => {}), 1500);
    return () => clearInterval(t);
  }, [runId, running]);

  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && run && run.status !== "running") {
      refreshMeta();
      if (run.status === "error") notify(run.error || "The run stopped with an error.", "err");
    }
    wasRunning.current = running;
  }, [running, run, refreshMeta, notify]);

  /* ---- the test library = Excel cases + tests built in the UI */
  const catalog = useMemo(() => [...(upload?.cases || []), ...custom], [upload, custom]);
  const selectedIds = useMemo(() => catalog.filter((c) => !skip.has(c.id)).map((c) => c.id), [catalog, skip]);
  const toggle = (id) => setSkip((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function handleFile(file) {
    if (!file) return;
    setRun(null);
    if (!appId) { notify("Create an application first (Applications tab).", "err"); return; }
    setUploading(true);
    try { setUpload(await api.uploadExcel(file, appId)); setSkip(new Set()); refreshMeta(); notify(`${file.name} saved to the database`); }
    catch (e) { setUpload(null); notify(e.message, "err"); }
    finally { setUploading(false); }
  }
  async function pickRecent(id) {
    setRun(null);
    try { setUpload(await api.getUpload(id)); setSkip(new Set()); } catch (e) { notify(e.message, "err"); }
  }
  async function handleRun(ids) {
    const only = ids || selectedIds;
    try {
      const { run_id } = await api.startRun({
        application_id: appId, upload_id: upload?.upload_id || null, only, cdp_url: settings.cdpUrl.trim(),
        allow_save: settings.allowSave, headless: settings.headless, slow_mo: Number(settings.slowMo),
      });
      setFilter("all"); setTab("studio");
      setRun({ id: run_id, status: "running", cases: catalog.filter((c) => only.includes(c.id)), results: {}, current: null });
    } catch (e) { notify(e.message, "err"); }
  }
  async function openRun(id) {
    try { setRun(await api.getRun(id)); setFilter("all"); setTab("studio"); window.scrollTo({ top: 0 }); }
    catch (e) { notify(e.message, "err"); }
  }
  async function removeCustom(c) {
    try { await api.deleteCustom(c.db_id); setCustom((l) => l.filter((x) => x.id !== c.id)); notify("Test deleted"); }
    catch (e) { notify(e.message, "err"); }
  }
  async function saveBuilder(b, runAfter) {
    const body = { application_id: appId, name: b.name, expected: b.expected, test_key: b.key, params: b.params, steps: b.key === "CUSTOM_STEPS" ? b.steps : [] };
    try {
      const saved = await api.saveCustom(b.db_id, body);
      setCustom((l) => (b.db_id ? l.map((x) => (x.db_id === b.db_id ? saved : x)) : [...l, saved]));
      setBuilder(null);
      if (runAfter) { setRun(null); await handleRun([saved.id]); } else notify("Test saved");
    } catch (e) { notify(e.message, "err"); }
  }

  const resultsMode = !!run;
  const cases = resultsMode ? run.cases || [] : catalog;
  const results = run?.results || {};
  const counts = useMemo(() => {
    const v = Object.values(results);
    const c = { pass: 0, fail: 0, skip: 0, reg: 0, fixed: 0 };
    v.forEach((r) => {
      if (r.status === "PASS") c.pass++; else if (r.status === "FAIL") c.fail++; else if (r.status === "SKIP") c.skip++;
      if (r.status === "FAIL" && r.prev_status === "PASS") c.reg++;
      if (r.status === "PASS" && r.prev_status === "FAIL") c.fixed++;
    });
    c.total = resultsMode ? cases.length : 0;
    c.notRun = Math.max(c.total - v.length, 0);
    return c;
  }, [results, cases.length, resultsMode]);

  const visible = resultsMode ? cases.filter((c) => {
    const r = results[c.id];
    if (filter === "all") return true;
    if (!r) return false;
    return filter === "REG" ? r.status === "FAIL" && r.prev_status === "PASS" : r.status === filter;
  }) : cases;
  const videos = cases.map((c) => results[c.id]).filter((r) => r?.video);

  const needsUrl = !config.demo && !/^https?:\/\//.test(activeApp?.base_url || "");
  const canRun = !!activeApp && selectedIds.length > 0 && !running && !needsUrl && !config.db_error;
  const done = counts.pass + counts.fail + counts.skip;
  const allSelected = selectedIds.length === catalog.length;

  return (
    <>
      <header className="topbar">
        <div className="brand"><span className="logo" />APEX Test Studio{config.demo && <em className="demo-pill">Demo</em>}</div>
        <nav className="tabs">
          <button className={tab === "applications" ? "on" : ""} onClick={() => setTab("applications")}>Applications</button>
          <button className={tab === "studio" ? "on" : ""} onClick={() => setTab("studio")}>Studio</button>
          <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>History &amp; Insights</button>
        </nav>
        <div className="top-right">
          {apps && apps.length > 0 && (
            <label className="app-switch" title={running ? "Wait for the run to finish before switching" : "Application under test"}>
              <Svg name="globe" size={15} />
              <select value={appId || ""} disabled={running} onChange={(e) => { setSettings((s) => ({ ...s, activeAppId: Number(e.target.value) })); setTab("studio"); }}>
                {apps.map((a) => <option key={a.id} value={a.id}>{a.name} · {ENV_LABEL[a.environment] || a.environment}</option>)}
              </select>
            </label>
          )}
          <DbChip config={config} />
          <button className="icon-btn" title="Switch theme" aria-label="Switch theme" onClick={() => setSettings((s) => ({ ...s, theme: s.theme === "dark" ? "light" : "dark" }))}>
            <Svg name={settings.theme === "dark" ? "sun" : "moon"} size={17} />
          </button>
        </div>
      </header>

      <main className="shell">
        {config.db_error && (
          <div className="banner err"><b>Database not reachable.</b> {config.db_error}. Check <code>DATABASE_URL</code> in <code>backend/.env</code> and restart the server.</div>
        )}

        {tab === "applications" ? (
          <Applications apps={apps} activeId={appId} running={running} notify={notify} onReload={loadApps}
                        onUse={(id) => { setSettings((s) => ({ ...s, activeAppId: id })); setTab("studio"); }} />
        ) : tab === "history" ? (
          <History appId={appId} apps={apps} onOpen={openRun} onChanged={refreshMeta} notify={notify} />
        ) : apps && apps.length === 0 ? (
          <div className="card empty"><Svg name="globe" size={30} /><p>Register the application you want to test first.</p>
            <button className="run-btn inline" onClick={() => setTab("applications")}>Open Applications</button></div>
        ) : (
          <>
            <section className="hero">
              <div>
                <h1>Automated UI testing</h1>
                <p>Run your Excel test cases or build your own, then replay a video of every execution. Everything is stored in PostgreSQL.</p>
                {activeApp && <p className="now-testing"><Svg name="globe" size={14} /> Testing <b>{activeApp.name}</b><span className={"env-pill " + activeApp.environment}>{ENV_LABEL[activeApp.environment]}</span></p>}
              </div>
              <Ring counts={counts} done={done} running={running} />
            </section>

            <div className="grid">
              <section className="card control">
                <div className="card-head"><h2>Test library</h2>{activeApp && <small className="muted">{activeApp.name}</small>}</div>
                <div className={"drop" + (dragOver ? " over" : "")}
                     onClick={() => fileInput.current?.click()}
                     onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                     onDragLeave={() => setDragOver(false)}
                     onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}>
                  <span className="drop-ico"><Svg name="upload" size={20} /></span>
                  <strong>{uploading ? "Reading workbook…" : "Drop an Excel file here"}</strong>
                  <span>or click to browse · .xlsx with a Test_Cases sheet</span>
                  <input ref={fileInput} type="file" accept=".xlsx,.xlsm" hidden
                         onChange={(e) => { handleFile(e.target.files[0]); e.target.value = ""; }} />
                </div>

                {upload && (
                  <div className="loaded"><span className="tick">✓</span><div><b>{upload.cases.length} test case{upload.cases.length === 1 ? "" : "s"} loaded</b><small>{upload.filename}</small></div></div>
                )}
                {upload?.unsupported?.length > 0 && (
                  <div className="banner warn">No automation yet for <b>{upload.unsupported.join(", ")}</b>; they will be marked Skipped.</div>
                )}
                {recent.length > 0 && (
                  <div className="recent">
                    <small>Recent workbooks</small>
                    <div>{recent.map((u) => (
                      <button key={u.id} className={"chip" + (upload?.upload_id === u.id ? " on" : "")} onClick={() => pickRecent(u.id)} title={fmtDate(u.created_at)}>
                        {u.filename} <em>{u.n}</em>
                      </button>))}
                    </div>
                  </div>
                )}

                <button className="link-btn" onClick={() => setShowSettings((v) => !v)}>{showSettings ? "Hide run settings" : "Run settings"}</button>
                {showSettings && (
                  <div className="settings">
                    <div className="field"><label>Application under test</label>
                      <div className="app-url"><b>{activeApp?.name}</b><span>{activeApp?.base_url || "no Base URL yet"}</span>
                        <button className="text-btn" onClick={() => setTab("applications")}>Change</button></div></div>
                    <Field label="Chrome debugging address"><input type="text" value={settings.cdpUrl}
                      onChange={(e) => setSettings({ ...settings, cdpUrl: e.target.value })} /></Field>
                    <Field label="Speed">
                      <select value={settings.slowMo} onChange={(e) => setSettings({ ...settings, slowMo: Number(e.target.value) })}>
                        <option value={0}>Fastest</option><option value={60}>Normal (easy to follow in the video)</option><option value={200}>Slow</option>
                      </select></Field>
                    <label className="check"><input type="checkbox" checked={settings.allowSave} onChange={(e) => setSettings({ ...settings, allowSave: e.target.checked })} />Allow tests that click Save (test employee only)</label>
                    <label className="check"><input type="checkbox" checked={settings.headless} onChange={(e) => setSettings({ ...settings, headless: e.target.checked })} />Run hidden (headless)</label>
                    <p className="note">Before running: start Chrome with <code>--remote-debugging-port=9222</code>, log in to the app and keep the Timesheet page open.</p>
                  </div>
                )}

                <button className="run-btn" disabled={!canRun} onClick={() => handleRun()}>
                  <Svg name="play" size={14} />
                  {running ? `Running… ${done}/${counts.total}`
                    : selectedIds.length === 0 ? "Select tests to run"
                    : allSelected ? `Run all ${selectedIds.length} test${selectedIds.length === 1 ? "" : "s"}` : `Run ${selectedIds.length} selected`}
                </button>
                <button className="ghost-btn" onClick={() => setBuilder({ db_id: null, name: "", expected: "", key: "CUSTOM_STEPS", params: {}, steps: [{ action: "open", target: "timesheet", value: "" }] })}>
                  <Svg name="plus" size={15} /> Create a test case
                </button>
                {needsUrl && catalog.length > 0 && !running && <p className="note">This application has no Base URL yet. <button className="text-btn" onClick={() => setTab("applications")}>Add it in Applications</button></p>}
              </section>

              <section className="card results">
                <div className="card-head">
                  <h2>{resultsMode ? "Results" : "Select tests to run"}</h2>
                  {resultsMode
                    ? <span className={"badge " + (run.status || "")}>{running ? "Running" : run.status === "error" ? "Stopped" : "Finished"}</span>
                    : catalog.length > 0 && <span className="muted small">{selectedIds.length} of {catalog.length} selected</span>}
                </div>

                {resultsMode && run.status === "error" && <div className="banner err">{run.error}</div>}

                {catalog.length === 0 && !resultsMode ? (
                  <div className="empty"><Svg name="film" size={30} /><p>Upload an Excel file or create a test case to get started.</p></div>
                ) : (
                  <>
                    {resultsMode ? (
                      <>
                        <div className="stats">
                          <Stat k="pass" label="Passed" v={counts.pass} /><Stat k="fail" label="Failed" v={counts.fail} />
                          <Stat k="skip" label="Skipped" v={counts.skip} /><Stat k="idle" label="Not run" v={counts.notRun} />
                        </div>
                        {run?.prev_run && (counts.reg > 0 || counts.fixed > 0) && (
                          <div className="radar">
                            <b>Compared with run {run.prev_run}</b>
                            {counts.reg > 0 && <span className="tag bad">{counts.reg} regression{counts.reg > 1 ? "s" : ""}</span>}
                            {counts.fixed > 0 && <span className="tag good">{counts.fixed} fixed</span>}
                          </div>
                        )}
                        <div className="toolbar">
                          <div className="filters">
                            {FILTERS.map(([k, label]) => (
                              <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
                                {label}{k === "REG" && counts.reg > 0 && <em>{counts.reg}</em>}
                              </button>))}
                          </div>
                          <button className="text-btn" disabled={running} onClick={() => setRun(null)}><Svg name="back" size={14} /> Back to test list</button>
                        </div>
                      </>
                    ) : (
                      <div className="toolbar">
                        <div className="filters">
                          <button onClick={() => setSkip(new Set())} disabled={allSelected}>Select all</button>
                          <button onClick={() => setSkip(new Set(catalog.map((c) => c.id)))} disabled={selectedIds.length === 0}>Clear</button>
                        </div>
                        <small className="muted">Tick the tests to run, or use Run all.</small>
                      </div>
                    )}

                    <div className="wall">
                      {visible.map((c) => (
                        <CaseCard key={c.id} c={c} r={results[c.id]} mode={resultsMode ? "results" : "select"}
                                  checked={!skip.has(c.id)} onToggle={() => toggle(c.id)} active={run?.current === c.id}
                                  onWatch={() => setWatch(c.id)} canRun={canRun}
                                  onRunOne={() => handleRun([c.id])}
                                  onEdit={() => setBuilder({ db_id: c.db_id, name: c.name, expected: c.expected || "", key: c.key, params: c.params || {}, steps: c.steps?.length ? c.steps : [{ action: "open", target: "", value: "" }] })}
                                  onDelete={() => removeCustom(c)} />
                      ))}
                      {visible.length === 0 && <p className="note">Nothing matches this filter.</p>}
                    </div>

                    {resultsMode && !running && Object.keys(results).length > 0 && (
                      <div className="exports">
                        <a href={`/api/runs/${run.id}/report`} target="_blank" rel="noreferrer">Open HTML report</a>
                        <a href={`/api/runs/${run.id}/csv`}>Download CSV</a>
                      </div>
                    )}
                  </>
                )}
              </section>
            </div>
          </>
        )}
      </main>

      {watch && <Theater id={watch} videos={videos} results={results} onClose={() => setWatch(null)} />}
      {builder && <Builder initial={builder} settings={settings} canRun={!running && !needsUrl && !config.db_error}
                           onClose={() => setBuilder(null)} onSave={saveBuilder} />}
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={"toast " + t.kind}>{t.msg}</div>)}</div>
    </>
  );
}

/* ------------------------------------------------------------------ pieces */
function Field({ label, children }) { return <div className="field"><label>{label}</label>{children}</div>; }

function Stat({ k, label, v }) {
  const n = useCountUp(v);
  return <div className={"stat " + k}><small>{label}</small><b>{n}</b></div>;
}

function DbChip({ config }) {
  const d = config.db;
  const used = d ? Math.min(100, (d.db_mb / d.limit_mb) * 100) : 0;
  return (
    <div className={"dbchip" + (config.db_error ? " bad" : d ? " ok" : "")} title={d ? `${d.version}\n${d.runs} runs, ${d.media} files (${d.media_mb} MB evidence)` : ""}>
      <Svg name="db" size={15} /><span className="dot" />
      <div>
        <b>{config.db_error ? "Database offline" : d ? `PostgreSQL · ${d.database}` : "Connecting…"}</b>
        {d && <small>{d.db_mb} / {d.limit_mb} MB · {d.runs} runs</small>}
      </div>
      {d && <div className="meter"><i style={{ width: used + "%" }} className={used > 80 ? "hot" : ""} /></div>}
    </div>
  );
}

function Ring({ counts, done, running }) {
  const R = 54, C = 2 * Math.PI * R, total = counts.total || 1;
  let offset = 0;
  const rate = counts.total ? Math.round((counts.pass / counts.total) * 100) : 0;
  const shown = useCountUp(rate, 600);
  return (
    <div className="ring">
      <svg viewBox="0 0 130 130">
        <circle cx="65" cy="65" r={R} className="track" />
        {[["pass", counts.pass], ["fail", counts.fail], ["skip", counts.skip]].filter(([, n]) => n > 0).map(([k, n]) => {
          const len = (n / total) * C;
          const el = <circle key={k} cx="65" cy="65" r={R} className={"arc " + k} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} />;
          offset += len; return el;
        })}
      </svg>
      <div className="ring-mid">
        <b>{counts.total ? shown : "–"}{counts.total ? <sup>%</sup> : null}</b>
        <small>{running ? `${done}/${counts.total} done` : counts.total ? "pass rate" : "no run yet"}</small>
      </div>
    </div>
  );
}

function CaseCard({ c, r, mode, checked, onToggle, active, onWatch, canRun, onRunOne, onEdit, onDelete }) {
  const [confirm, setConfirm] = useState(false);
  const vid = useRef(null);
  const sel = mode === "select";
  const st = r ? r.status.toLowerCase() : active ? "run" : "idle";
  const reg = r?.status === "FAIL" && r?.prev_status === "PASS";
  const fixed = r?.status === "PASS" && r?.prev_status === "FAIL";
  const click = () => (sel ? onToggle() : r?.video && onWatch());
  return (
    <article className={"case " + (sel ? (checked ? "sel" : "off") : st)} onClick={click}>
      <div className="case-media"
           onMouseEnter={() => vid.current?.play().catch(() => {})}
           onMouseLeave={() => { if (vid.current) { vid.current.pause(); vid.current.currentTime = 0.4; } }}>
        {!sel && r?.video ? (
          <>
            <video ref={vid} src={r.video + "#t=0.4"} poster={r.shot || undefined} muted loop playsInline preload="metadata" />
            <span className="play"><Svg name="play" size={16} /></span>
          </>
        ) : (
          <div className="ph">
            {active ? <span className="pulse" /> : <Svg name="film" size={22} />}
            <small>{sel ? (c.custom ? `Custom · ${c.key === "CUSTOM_STEPS" ? (c.steps?.length || 0) + " steps" : "built-in check"}` : c.key) : active ? "recording…" : r ? "no video" : "waiting"}</small>
          </div>
        )}
        {sel ? <span className="check-box" aria-hidden>{checked ? "✓" : ""}</span>
             : <span className={"pill " + st}>{r ? r.status : active ? "RUNNING" : "QUEUED"}</span>}
        {c.custom && <span className="flag custom">Custom</span>}
        {reg && <span className="flag bad">Regression</span>}
        {fixed && <span className="flag good">Fixed</span>}
      </div>
      <div className="case-body">
        <div className="case-title"><code>{c.id}</code><span>{c.name}</span></div>
        {c.expected && <p><em>Expected</em>{c.expected}</p>}
        {r && <p className="actual"><em>Actual</em>{r.detail}</p>}
        {r && r.secs ? <small className="secs">{r.secs}s</small> : null}
        {sel && (
          <div className="card-actions" onClick={(e) => e.stopPropagation()}>
            <button className="mini" disabled={!canRun} onClick={onRunOne} title="Run only this test and record its video"><Svg name="play" size={11} /> Run only this</button>
            {c.custom && <>
              <button className="mini icon" onClick={onEdit} title="Edit" aria-label="Edit test"><Svg name="edit" size={13} /></button>
              {confirm
                ? <button className="mini danger" onClick={onDelete} onBlur={() => setConfirm(false)} autoFocus>Delete?</button>
                : <button className="mini icon" onClick={() => setConfirm(true)} title="Delete" aria-label="Delete test"><Svg name="trash" size={13} /></button>}
            </>}
          </div>
        )}
      </div>
    </article>
  );
}

function Theater({ id, videos, results, onClose }) {
  const [cur, setCur] = useState(id);
  const [mode, setMode] = useState("video");
  const ref = useRef(null);
  const list = videos.map((v) => v.test_case_id);
  const r = results[cur];
  const idx = list.indexOf(cur);
  const go = useCallback((d) => { if (list.length) { setCur(list[(idx + d + list.length) % list.length]); setMode("video"); } }, [idx, list]);
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onClose(); if (e.key === "ArrowRight") go(1); if (e.key === "ArrowLeft") go(-1); };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [go, onClose]);
  if (!r) return null;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="theater" onClick={(e) => e.stopPropagation()}>
        <div className="stage">
          {mode === "video" ? <video key={r.video} ref={ref} src={r.video} controls autoPlay /> : <img src={r.shot} alt="Final screenshot" />}
        </div>
        <aside>
          <button className="x" onClick={onClose} aria-label="Close"><Svg name="x" /></button>
          <span className={"pill " + r.status.toLowerCase()}>{r.status}</span>
          <h3>{r.test_case_id}</h3><p className="tname">{r.name}</p>
          {r.expected && <div className="kv"><em>Expected</em>{r.expected}</div>}
          <div className="kv"><em>Actual</em>{r.detail}</div>
          {r.data != null && r.data !== "" && <div className="kv"><em>Sample data</em><code>{r.data}</code></div>}
          <div className="seg">
            <button className={mode === "video" ? "on" : ""} onClick={() => setMode("video")}>Video</button>
            {r.shot && <button className={mode === "shot" ? "on" : ""} onClick={() => setMode("shot")}>Screenshot</button>}
          </div>
          {mode === "video" && (
            <div className="seg">{[1, 1.5, 2].map((s) => <button key={s} onClick={() => { if (ref.current) ref.current.playbackRate = s; }}>{s}×</button>)}</div>
          )}
          <div className="nav">
            <button onClick={() => go(-1)}>← Prev</button><span>{idx + 1} / {list.length}</span><button onClick={() => go(1)}>Next →</button>
          </div>
          <a className="dl" href={r.video} download>Download video</a>
        </aside>
      </div>
    </div>
  );
}

/* ---------- create / edit a test */
function Builder({ initial, settings, canRun, onClose, onSave }) {
  const [b, setB] = useState(initial);
  const [busy, setBusy] = useState(false);
  const builtin = BUILTIN.find((x) => x.key === b.key);
  const isSteps = b.key === "CUSTOM_STEPS";
  const setStep = (i, patch) => setB((s) => ({ ...s, steps: s.steps.map((st, n) => (n === i ? { ...st, ...patch } : st)) }));
  const move = (i, d) => setB((s) => {
    const a = [...s.steps], j = i + d;
    if (j < 0 || j >= a.length) return s;
    [a[i], a[j]] = [a[j], a[i]]; return { ...s, steps: a };
  });
  const valid = b.name.trim() && (!isSteps || b.steps.length > 0);
  async function submit(runAfter) { setBusy(true); await onSave(b, runAfter); setBusy(false); }
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h3>{b.db_id ? "Edit test case" : "Create a test case"}</h3>
          <button className="x flat" onClick={onClose} aria-label="Close"><Svg name="x" /></button>
        </div>
        <div className="sheet-body">
          <Field label="Name"><input type="text" autoFocus placeholder="e.g. Save button is disabled for future weeks" value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} /></Field>
          <Field label="Expected result (shown in the report)"><input type="text" placeholder="What should happen?" value={b.expected} onChange={(e) => setB({ ...b, expected: e.target.value })} /></Field>
          <Field label="Type">
            <select value={b.key} onChange={(e) => setB({ ...b, key: e.target.value, params: {} })}>
              <option value="CUSTOM_STEPS">Custom steps (build it yourself)</option>
              <optgroup label="Built-in checks">{BUILTIN.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</optgroup>
            </select>
          </Field>

          {isSteps ? (
            <div className="steps">
              <div className="steps-head"><b>Steps</b><small>Run in order. The test stops at the first step that fails.</small></div>
              {b.steps.map((st, i) => {
                const a = ACTIONS.find((x) => x.k === st.action) || ACTIONS[0];
                return (
                  <div className="step" key={i}>
                    <span className="num">{i + 1}</span>
                    <select value={st.action} onChange={(e) => setStep(i, { action: e.target.value })}>{ACTIONS.map((x) => <option key={x.k} value={x.k}>{x.label}</option>)}</select>
                    <div className={"step-in" + (a.t && a.v ? " two" : "")}>
                      {a.t && <input type="text" placeholder={a.t + (a.tph ? ` (e.g. ${a.tph})` : "")} value={st.target} onChange={(e) => setStep(i, { target: e.target.value })} />}
                      {a.v && <input type="text" placeholder={a.v + (a.vph ? ` (${a.vph})` : "")} value={st.value} onChange={(e) => setStep(i, { value: e.target.value })} />}
                    </div>
                    <div className="step-act">
                      <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><Svg name="up" size={13} /></button>
                      <button onClick={() => move(i, 1)} disabled={i === b.steps.length - 1} aria-label="Move down"><Svg name="down" size={13} /></button>
                      <button onClick={() => setB({ ...b, steps: b.steps.filter((_, n) => n !== i) })} aria-label="Remove step"><Svg name="x" size={13} /></button>
                    </div>
                  </div>
                );
              })}
              <button className="text-btn" onClick={() => setB({ ...b, steps: [...b.steps, { action: "click", target: "", value: "" }] })}><Svg name="plus" size={14} /> Add step</button>
              <p className="note">Targets can be visible text, a field label, or a CSS selector such as <code>#P4_HOURS</code>.</p>
            </div>
          ) : (
            <div className="steps">
              {builtin?.fields.map((f) => (
                <Field key={f.k} label={f.label}>
                  {f.options
                    ? <select value={b.params[f.k] || f.options[0]} onChange={(e) => setB({ ...b, params: { ...b.params, [f.k]: e.target.value } })}>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
                    : <input type="text" placeholder={f.ph} value={b.params[f.k] || ""} onChange={(e) => setB({ ...b, params: { ...b.params, [f.k]: e.target.value } })} />}
                </Field>))}
              {builtin?.saves && <div className="banner warn">This check saves hours. Turn on <b>Allow tests that click Save</b> in Run settings{settings.allowSave ? " (on)" : ""}.</div>}
            </div>
          )}
        </div>
        <div className="sheet-foot">
          <button className="ghost-btn" onClick={onClose}>Cancel</button>
          <button className="ghost-btn" disabled={!valid || busy} onClick={() => submit(false)}>Save</button>
          <button className="run-btn inline" disabled={!valid || busy || !canRun} onClick={() => submit(true)} title={canRun ? "" : "Set the application's Base URL first"}>
            <Svg name="play" size={13} /> Save &amp; run with video
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- application manager */
function Applications({ apps, activeId, running, notify, onReload, onUse }) {
  const [form, setForm] = useState(null);
  const [conn, setConn] = useState({});                // app id -> last Test Connection result
  const [confirm, setConfirm] = useState(null);

  async function test(a) {
    setConn((c) => ({ ...c, [a.id]: { loading: true } }));
    try { const r = await api.testConnection(a.base_url); setConn((c) => ({ ...c, [a.id]: r })); }
    catch (e) { setConn((c) => ({ ...c, [a.id]: { ok: false, error: e.message } })); }
  }
  async function remove(a) {
    try { await api.deleteApp(a.id); setConfirm(null); notify(`${a.name} deleted`); onReload(); }
    catch (e) { setConfirm(null); notify(e.message, "err"); }
  }
  async function save(f) {
    const saved = await api.saveApp(f.id, { name: f.name, base_url: f.base_url, environment: f.environment, auth_type: f.auth_type, description: f.description });
    setForm(null); onReload();
    if (f.id) notify("Application saved"); else { notify(`${saved.name} added`); onUse(saved.id); }
  }
  return (
    <>
      <section className="hero slim">
        <div><h1>Applications</h1><p>Register each application you test. Every application has its own URL, tests, workbooks and run history.</p></div>
        <button className="run-btn inline" onClick={() => setForm({ ...BLANK_APP })}><Svg name="plus" size={14} /> Add application</button>
      </section>
      {!apps ? <p className="note">Loading…</p> : (
        <div className="apps-grid">
          {apps.map((a) => {
            const c = conn[a.id], active = a.id === activeId, lr = a.last_run;
            return (
              <article key={a.id} className={"card app-card" + (active ? " active" : "")}>
                <div className="app-top">
                  <h3>{a.name}</h3>
                  <span className={"env-pill " + a.environment}>{ENV_LABEL[a.environment] || a.environment}</span>
                  {active && <span className="badge finished">In use</span>}
                </div>
                <div className="app-link">{a.base_url ? <a href={a.base_url} target="_blank" rel="noreferrer">{a.base_url}</a> : <span className="warn-text">No Base URL yet - click Edit</span>}</div>
                {a.description && <p className="app-desc">{a.description}</p>}
                <div className="app-stats">
                  <div><b>{a.tests}</b><small>custom tests</small></div>
                  <div><b>{a.workbooks}</b><small>workbooks</small></div>
                  <div><b>{a.runs}</b><small>runs</small></div>
                  <div><b>{lr ? `${lr.total ? Math.round((lr.pass / lr.total) * 100) : 0}%` : "-"}</b><small>last pass rate</small></div>
                </div>
                {c && (
                  <div className={"conn " + (c.loading ? "" : c.ok ? "ok" : "bad")}>
                    {c.loading ? "Checking…" : c.ok ? `✓ ${c.note} HTTP ${c.status} · ${c.ms} ms` : `✕ Could not connect: ${c.error || c.note}`}
                  </div>
                )}
                <div className="card-actions">
                  <button className="mini" disabled={active || running} onClick={() => onUse(a.id)}><Svg name="play" size={11} /> {active ? "Selected" : "Use in Studio"}</button>
                  <button className="mini" disabled={!a.base_url || c?.loading} onClick={() => test(a)}><Svg name="plug" size={12} /> Test connection</button>
                  <button className="mini icon" onClick={() => setForm({ ...a })} title="Edit" aria-label="Edit application"><Svg name="edit" size={13} /></button>
                  {confirm === a.id
                    ? <button className="mini danger" onClick={() => remove(a)} onBlur={() => setConfirm(null)} autoFocus>Delete app + its tests?</button>
                    : <button className="mini icon" onClick={() => setConfirm(a.id)} title="Delete" aria-label="Delete application"><Svg name="trash" size={13} /></button>}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {form && <AppForm initial={form} onClose={() => setForm(null)} onSave={save} />}
    </>
  );
}

function AppForm({ initial, onClose, onSave }) {
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [probe, setProbe] = useState(null);
  const urlOk = /^https?:\/\/\S+$/.test(f.base_url.trim());
  const valid = f.name.trim() && urlOk;
  async function submit() {
    setBusy(true); setErr("");
    try { await onSave({ ...f, name: f.name.trim(), base_url: f.base_url.trim() }); }
    catch (e) { setErr(e.message); setBusy(false); }
  }
  async function check() {
    setProbe({ loading: true });
    try { setProbe(await api.testConnection(f.base_url.trim())); } catch (e) { setProbe({ ok: false, error: e.message }); }
  }
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet narrow" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head"><h3>{f.id ? "Edit application" : "Add application"}</h3>
          <button className="x flat" onClick={onClose} aria-label="Close"><Svg name="x" /></button></div>
        <div className="sheet-body">
          <Field label="Application name"><input type="text" autoFocus placeholder="e.g. Timesheet App" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Base URL"><input type="text" placeholder="https://oracleapex.com/ords/r/your_workspace/timesheet-app" value={f.base_url}
            onChange={(e) => { setF({ ...f, base_url: e.target.value }); setProbe(null); }} /></Field>
          <div className="two-col">
            <Field label="Environment">
              <select value={f.environment} onChange={(e) => setF({ ...f, environment: e.target.value })}>
                {Object.entries(ENV_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select></Field>
            <Field label="Authentication">
              <select value={f.auth_type} onChange={(e) => setF({ ...f, auth_type: e.target.value })}>
                <option value="chrome_session">Logged-in Chrome (current)</option>
                <option value="credentials" disabled>Username &amp; password (coming next)</option>
              </select></Field>
          </div>
          <Field label="Description (optional)"><input type="text" placeholder="What is this application?" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <div className="probe">
            <button className="mini" disabled={!urlOk || probe?.loading} onClick={check}><Svg name="plug" size={12} /> Test connection</button>
            {probe && <span className={"conn inline " + (probe.loading ? "" : probe.ok ? "ok" : "bad")}>
              {probe.loading ? "Checking…" : probe.ok ? `✓ ${probe.note} HTTP ${probe.status} · ${probe.ms} ms` : `✕ ${probe.error || probe.note}`}</span>}
          </div>
          {err && <div className="banner err">{err}</div>}
        </div>
        <div className="sheet-foot">
          <button className="ghost-btn" onClick={onClose}>Cancel</button>
          <button className="run-btn inline" disabled={!valid || busy} onClick={submit}>{f.id ? "Save changes" : "Add application"}</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- history & insights */
function History({ appId, apps, onOpen, onChanged, notify }) {
  const [runs, setRuns] = useState(null);
  const [an, setAn] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [all, setAll] = useState(false);
  const appName = apps?.find((a) => a.id === appId)?.name;
  const load = useCallback(() => {
    const scopeId = all ? null : appId;
    api.listRuns(scopeId).then(setRuns).catch((e) => { setRuns([]); notify(e.message, "err"); });
    api.getAnalytics(scopeId).then(setAn).catch((e) => { setAn({ trend: [], problem_tests: [] }); notify(e.message, "err"); });
  }, [notify, all, appId]);
  useEffect(() => { load(); }, [load]);
  async function del(id) {
    try { await api.deleteRun(id); setConfirm(null); notify("Run deleted"); load(); onChanged(); }
    catch (e) { setConfirm(null); notify(e.message, "err"); }
  }
  return (
    <>
      <section className="hero slim"><div><h1>History &amp; insights</h1><p>Trends and past runs, straight from PostgreSQL.</p></div>
        <label className="check scope"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />Show all applications{!all && appName ? ` (now: ${appName})` : ""}</label></section>
      <div className="grid hist">
        <section className="card">
          <div className="card-head"><h2>Pass-rate trend</h2><small className="muted">last {an?.trend?.length || 0} runs · click a bar to open it</small></div>
          <Trend data={an?.trend || []} onOpen={onOpen} />
        </section>
        <section className="card">
          <div className="card-head"><h2>Most failing tests</h2></div>
          {(an?.problem_tests || []).length === 0 ? <p className="note">No failures recorded.</p> : (
            <ul className="probs">{an.problem_tests.map((p) => (
              <li key={p.test_case_id}><code>{p.test_case_id}</code><span>{p.name}</span><b>{p.fails}/{p.runs}</b>
                <div className="pbar"><i style={{ width: `${(p.fails / p.runs) * 100}%` }} /></div></li>))}
            </ul>)}
        </section>
      </div>
      <section className="card">
        <div className="card-head"><h2>Run history</h2><button className="text-btn" onClick={load}>Refresh</button></div>
        {!runs ? <p className="note">Loading…</p> : runs.length === 0 ? <p className="note">No runs yet. Start one from the Studio tab.</p> : (
          <div className="table">
            {runs.map((r) => (
              <div className="row" key={r.id}>
                <div className="r-main"><b>{fmtDate(r.started_at)}</b><small>{r.application_name ? r.application_name + " · " : ""}{r.filename}{r.demo ? " · demo" : ""}</small></div>
                <span className="mini-bar"><i className="p" style={{ width: `${(r.pass / (r.total || 1)) * 100}%` }} /><i className="f" style={{ width: `${(r.fail / (r.total || 1)) * 100}%` }} /><i className="s" style={{ width: `${(r.skip / (r.total || 1)) * 100}%` }} /></span>
                <div className="r-num"><b className="g">{r.pass}</b><b className="r">{r.fail}</b><b className="a">{r.skip}</b><small>{pctOf(r)}%</small></div>
                <span className={"badge " + r.status}>{r.status}</span>
                <div className="r-act">
                  <button className="mini" onClick={() => onOpen(r.id)}>Open</button>
                  <a className="mini" href={`/api/runs/${r.id}/report`} target="_blank" rel="noreferrer">Report</a>
                  <a className="mini" href={`/api/runs/${r.id}/csv`}>CSV</a>
                  {confirm === r.id
                    ? <button className="mini danger" onClick={() => del(r.id)} onBlur={() => setConfirm(null)} autoFocus>Confirm delete</button>
                    : <button className="mini icon" onClick={() => setConfirm(r.id)} title="Delete run" aria-label="Delete run"><Svg name="trash" size={13} /></button>}
                </div>
              </div>))}
          </div>)}
      </section>
    </>
  );
}

function Trend({ data, onOpen }) {
  if (!data.length) return <div className="empty"><p>Run your tests to see the trend.</p></div>;
  const W = 640, H = 220, Pd = 28, bw = Math.min(34, (W - 2 * Pd) / data.length - 8);
  const max = Math.max(...data.map((d) => d.total), 1);
  const x = (i) => Pd + (i + 0.5) * ((W - 2 * Pd) / data.length);
  const line = data.map((d, i) => `${x(i)},${H - Pd - (d.pass / (d.total || 1)) * (H - 2 * Pd)}`).join(" ");
  return (
    <svg className="trend" viewBox={`0 0 ${W} ${H}`}>
      {[0, 0.5, 1].map((g) => <line key={g} x1={Pd} x2={W - Pd} y1={H - Pd - g * (H - 2 * Pd)} y2={H - Pd - g * (H - 2 * Pd)} className="grid-l" />)}
      {data.map((d, i) => {
        const h = (n) => (n / max) * (H - 2 * Pd);
        let y = H - Pd;
        const bars = [["pass", d.pass], ["fail", d.fail], ["skip", d.skip]].map(([k, n]) => { y -= h(n); return <rect key={k} x={x(i) - bw / 2} y={y} width={bw} height={Math.max(h(n), 0)} rx="2" className={"b " + k} />; });
        return (
          <g key={d.id} className="bar-g" role="button" tabIndex={0} onClick={() => onOpen(d.id)} onKeyDown={(e) => e.key === "Enter" && onOpen(d.id)}>
            <title>{`${fmtDate(d.started_at)}: ${d.pass} pass, ${d.fail} fail, ${d.skip} skip`}</title>
            <rect x={x(i) - bw} y={Pd / 2} width={bw * 2} height={H - Pd} className="hit" />
            {bars}<text x={x(i)} y={H - 8} textAnchor="middle">{new Date(d.started_at).toLocaleDateString([], { day: "2-digit", month: "short" })}</text>
          </g>);
      })}
      <polyline points={line} className="rate-line" />
      {data.map((d, i) => <circle key={d.id} cx={x(i)} cy={H - Pd - (d.pass / (d.total || 1)) * (H - 2 * Pd)} r="3" className="rate-dot" />)}
    </svg>
  );
}
