import type { Hono } from 'hono';

export interface DashboardHtmlOptions {
  authRequired: boolean;
  statusPath?: string;
}

function boolAttr(value: boolean): string {
  return value ? 'true' : 'false';
}

export function dashboardHtml(options: DashboardHtmlOptions): string {
  const statusPath = options.statusPath ?? '/status';
  const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<style>
:root{--bg:#f8fafc;--panel:#ffffff;--fg:#0f172a;--line:#cbd5e1;--blue:#2563eb;--green:#059669}
@media (prefers-color-scheme: dark){:root{--bg:#0b0d0f;--panel:#111417;--fg:#f8fafc;--line:#334155;--blue:#4ea1ff;--green:#3ddc97}}
</style>
<rect width="64" height="64" rx="14" fill="var(--bg)"/>
<rect x="13" y="14" width="38" height="30" rx="7" fill="var(--panel)" stroke="var(--line)" stroke-width="3"/>
<path d="M22 24h20M22 34h13" stroke="var(--fg)" stroke-width="4" stroke-linecap="round"/>
<circle cx="44" cy="38" r="6" fill="var(--green)"/>
<path d="M12 50h40" stroke="var(--blue)" stroke-width="5" stroke-linecap="round"/>
</svg>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0b0d0f" media="(prefers-color-scheme: dark)">
  <meta name="theme-color" content="#f8fafc" media="(prefers-color-scheme: light)">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(faviconSvg)}">
  <title>Local Model Gateway Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0d0f;
      --panel: #111417;
      --panel-2: #171b1f;
      --border: #2a343d;
      --muted: #a1a7ad;
      --text: #f2f5f7;
      --green: #3ddc97;
      --blue: #4ea1ff;
      --amber: #f2b84b;
      --red: #ff6b7a;
      --gray: #7c858e;
      --purple: #b38cff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      min-height: 100vh;
    }
    main { max-width: 1180px; margin: 0 auto; padding: 32px 20px 48px; }
    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 24px;
    }
    header > div:first-child { min-width: 0; }
    h1 { font-size: 3.25rem; line-height: 1; margin: 0; letter-spacing: 0; white-space: nowrap; }
    h2 { font-size: 1rem; margin: 0 0 14px; color: #cbd5e1; font-weight: 700; }
    p { margin: 0; color: var(--muted); }
    button, input, select {
      border: 1px solid var(--border);
      background: #0f172a;
      color: var(--text);
      border-radius: 6px;
      padding: 9px 11px;
      font: inherit;
    }
    button { cursor: pointer; }
    button:hover { border-color: var(--blue); }
    input { min-width: min(420px, 100%); }
    select { min-width: 128px; }
    .metric, .panel, .runtime-card, .telemetry-card { min-width: 0; }
    .controls { display: flex; align-items: center; gap: 10px; flex-wrap: nowrap; justify-content: flex-end; }
    .token-panel {
      display: none;
      width: 100%;
      margin: 0 0 18px;
      padding: 14px;
      border: 1px solid rgba(251, 191, 36, 0.35);
      border-radius: 8px;
      background: rgba(251, 191, 36, 0.08);
    }
    .token-panel.visible { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
    .error {
      display: none;
      margin: 0 0 18px;
      padding: 14px;
      border: 1px solid rgba(251, 113, 133, 0.45);
      border-radius: 8px;
      background: rgba(251, 113, 133, 0.09);
      color: #fecdd3;
    }
    .error.visible { display: block; }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .metric, .panel, .runtime-card {
      border: 1px solid var(--border);
      background: rgba(17, 20, 23, 0.94);
      border-radius: 8px;
      box-shadow: 0 18px 42px rgba(0, 0, 0, 0.22);
    }
    .metric { padding: 14px; min-height: 92px; }
    .label { color: var(--muted); font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0; margin-bottom: 9px; }
    .value { font-family: Menlo, Consolas, ui-monospace, monospace; font-size: 1.03rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
    .value.large { font-size: 1.35rem; font-weight: 700; }
    .metric-sub { margin-top: 7px; color: var(--muted); font-size: 0.8rem; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
    .panel { padding: 16px; overflow: hidden; }
    .runtime-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 12px; }
    .runtime-card { padding: 14px; overflow: hidden; }
    .runtime-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .runtime-name, .mono { font-family: Menlo, Consolas, ui-monospace, monospace; }
    .runtime-name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 4px 9px;
      font-size: 0.78rem;
      font-weight: 700;
      color: #020617;
      background: var(--gray);
      white-space: nowrap;
    }
    .state-loaded, .state-running, .state-succeeded { background: var(--green); }
    .state-work-succeeded, .state-runtime-load-succeeded, .state-runtime-unload-succeeded, .state-runtime-adopted-loaded { background: var(--green); }
    .state-loading { background: var(--blue); }
    .state-work-started, .state-runtime-load-started, .state-runtime-unload-started { background: var(--blue); }
    .state-prefill, .state-admitted, .state-loading-model { background: var(--blue); }
    .state-streaming, .state-receiving, .state-command-running { background: var(--green); }
    .state-queued, .state-work-queued { background: var(--amber); }
    .state-failed, .state-timed_out, .state-cancelled, .state-work-failed, .state-work-cancelled, .state-work-timed-out, .state-runtime-load-failed, .state-runtime-unload-failed { background: var(--red); }
    .state-unloading { background: var(--purple); }
    .kv { display: grid; grid-template-columns: minmax(92px, 120px) minmax(0, 1fr); gap: 6px 10px; font-size: 0.88rem; }
    .kv span:nth-child(odd) { color: var(--muted); }
    .kv span:nth-child(even), .error-lines, .telemetry-card p, .metric-sub {
      min-width: 0;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .progress {
      position: relative;
      height: 9px;
      overflow: hidden;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.18);
      margin: 10px 0 12px;
    }
    .progress-bar {
      height: 100%;
      width: 0;
      border-radius: inherit;
      background: var(--blue);
      transition: width 220ms ease;
    }
    .progress.indeterminate .progress-bar {
      width: 38%;
      animation: indeterminate 1.15s ease-in-out infinite;
    }
    .progress-bar.loaded, .progress-bar.streaming { background: var(--green); }
    .progress-bar.queued { background: var(--amber); }
    .progress-bar.failed { background: var(--red); }
    .telemetry-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .telemetry-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: linear-gradient(180deg, rgba(23, 27, 31, 0.96), rgba(15, 18, 22, 0.96));
      padding: 14px;
    }
    .telemetry-card strong { display: block; font-size: 1.02rem; margin-bottom: 5px; }
    .phase {
      display: inline-flex;
      align-items: center;
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 0.75rem;
      font-weight: 700;
      color: #020617;
      background: var(--gray);
    }
    .filter-row {
      display: grid;
      grid-template-columns: minmax(0, 2fr) repeat(3, minmax(120px, 1fr)) minmax(180px, 1.2fr);
      gap: 8px;
      margin: 0 0 12px;
    }
    .filter-row input, .filter-row select { min-width: 0; width: 100%; }
    .tabs {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin: 0 0 16px;
    }
    .tab {
      display: inline-flex;
      align-items: center;
      min-height: 40px;
      padding: 9px 13px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: rgba(15, 23, 42, 0.76);
      color: var(--muted);
      text-decoration: none;
      font-weight: 700;
    }
    .tab:hover { border-color: var(--blue); color: var(--text); }
    .tab.active {
      border-color: rgba(78, 161, 255, 0.68);
      background: rgba(78, 161, 255, 0.14);
      color: var(--text);
    }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    .tab-stack { display: grid; gap: 16px; }
    .timeline {
      display: grid;
      gap: 9px;
      max-height: 360px;
      overflow: auto;
      padding-right: 4px;
    }
    .timeline-event {
      display: grid;
      grid-template-columns: minmax(120px, 150px) minmax(0, 1fr);
      gap: 12px;
      padding: 10px 0;
      border-bottom: 1px solid rgba(148, 163, 184, 0.14);
    }
    .timeline-time { color: var(--muted); font-size: 0.8rem; }
    .timeline-message { min-width: 0; overflow-wrap: anywhere; }
    .timeline-meta { margin-top: 4px; color: var(--muted); font-size: 0.8rem; }
    .work-list { display: grid; gap: 10px; }
    .work-card {
      border: 1px solid rgba(148, 163, 184, 0.22);
      border-radius: 8px;
      background: rgba(15, 18, 22, 0.72);
      padding: 12px;
    }
    .work-card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .work-title { min-width: 0; }
    .work-title strong {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
      font-family: Menlo, Consolas, ui-monospace, monospace;
    }
    .work-title span { display: block; margin-top: 3px; color: var(--muted); font-size: 0.8rem; }
    .work-fields {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(135px, 1fr));
      gap: 9px 14px;
    }
    .work-field { min-width: 0; }
    .work-field.wide { grid-column: span 2; }
    .work-field span {
      display: block;
      color: var(--muted);
      font-size: 0.72rem;
      text-transform: uppercase;
      margin-bottom: 3px;
    }
    .work-field strong {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 0.88rem;
    }
    details summary { cursor: pointer; color: #dbeafe; }
    details pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: #fecdd3;
      margin: 6px 0 0;
      font-family: Menlo, Consolas, ui-monospace, monospace;
      font-size: 0.78rem;
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    #active-work, #gpu-queue, #recent-work { overflow-x: auto; padding-bottom: 4px; }
    #recent-work { max-height: 560px; overflow: auto; }
    #active-work table { min-width: 1040px; }
    #gpu-queue table { min-width: 680px; }
    #recent-work table { min-width: 1040px; }
    th, td {
      padding: 9px 8px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.18);
      text-align: left;
      vertical-align: top;
      white-space: nowrap;
    }
    th {
      color: #d4d8dc;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0;
      position: sticky;
      top: 0;
      background: var(--panel);
      z-index: 1;
    }
    td.id { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    td.compact { max-width: 105px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .empty { color: var(--muted); padding: 18px 0; }
    .last-updated { color: var(--muted); font-size: 0.88rem; white-space: nowrap; }
    .error-lines { margin-top: 10px; color: #fecdd3; font-size: 0.84rem; display: grid; gap: 4px; }
    @keyframes indeterminate {
      0% { transform: translateX(-120%); }
      100% { transform: translateX(270%); }
    }
    @media (max-width: 900px) {
      header { display: block; }
      .controls { justify-content: flex-start; margin-top: 18px; }
      h1 { font-size: 2.6rem; }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid { grid-template-columns: 1fr; }
      .filter-row { grid-template-columns: 1fr; }
      .tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .tab { justify-content: center; }
      .work-field.wide { grid-column: span 1; }
    }
    @media (max-width: 620px) {
      main { padding: 28px 16px 44px; }
      h1 { font-size: 2rem; }
    }
    @media (max-width: 430px) {
      main { padding-left: 12px; padding-right: 12px; }
      h1 { font-size: 1.55rem; }
      button, input, select { padding: 8px 9px; }
      .last-updated { font-size: 0.82rem; }
    }
    @media (max-width: 360px) {
      h1 { font-size: 1.15rem; }
    }
  </style>
</head>
<body>
  <main id="dashboard-root">
    <header>
      <div>
        <h1>Local Model Gateway Dashboard</h1>
      </div>
      <div class="controls">
        <span class="last-updated" id="last-updated">Not updated yet</span>
        <button id="toggle-polling" type="button">Pause</button>
      </div>
    </header>

    <section class="token-panel" id="token-panel">
      <div>
        <strong>Authentication required</strong>
        <p>Enter the gateway bearer token for this browser session.</p>
      </div>
      <input id="token-input" type="password" autocomplete="off" placeholder="Bearer token">
    </section>

    <section class="error" id="error-banner"></section>

    <section class="summary" id="summary"></section>

    <nav class="tabs" role="tablist" aria-label="Dashboard views">
      <a class="tab active" id="tab-link-overview" href="#overview" data-tab="overview" role="tab" aria-selected="true">Overview</a>
      <a class="tab" id="tab-link-runtimes" href="#runtimes" data-tab="runtimes" role="tab" aria-selected="false">Runtimes</a>
      <a class="tab" id="tab-link-queue" href="#queue" data-tab="queue" role="tab" aria-selected="false">Queue</a>
      <a class="tab" id="tab-link-history" href="#history" data-tab="history" role="tab" aria-selected="false">History</a>
    </nav>

    <section class="tab-panel active" id="tab-overview" data-tab-panel="overview" role="tabpanel" aria-labelledby="tab-link-overview">
      <section class="telemetry-strip" id="telemetry-strip"></section>
      <section class="panel">
        <h2>Active Work</h2>
        <div id="active-work"></div>
      </section>
    </section>

    <section class="tab-panel" id="tab-runtimes" data-tab-panel="runtimes" role="tabpanel" aria-labelledby="tab-link-runtimes">
      <section class="panel">
        <h2>Managed Runtimes</h2>
        <div class="runtime-grid" id="runtimes"></div>
      </section>
    </section>

    <section class="tab-panel" id="tab-queue" data-tab-panel="queue" role="tabpanel" aria-labelledby="tab-link-queue">
      <section class="grid">
        <section class="panel">
          <h2>Active Work</h2>
          <div id="queue-active-work"></div>
        </section>
        <section class="panel">
          <h2>GPU Queue</h2>
          <div id="gpu-queue"></div>
        </section>
      </section>
    </section>

    <section class="tab-panel" id="tab-history" data-tab-panel="history" role="tabpanel" aria-labelledby="tab-link-history">
      <section class="tab-stack">
        <section class="panel">
          <h2>Runtime Timeline</h2>
          <div id="runtime-timeline" class="timeline"></div>
        </section>
        <section class="panel">
          <h2>Recent Work</h2>
          <div class="filter-row">
            <select id="recent-runtime-filter" aria-label="Filter recent work by runtime"><option value="">All runtimes</option></select>
            <select id="recent-state-filter" aria-label="Filter recent work by state"><option value="">All states</option></select>
            <select id="recent-source-filter" aria-label="Filter recent work by source"><option value="">All sources</option></select>
            <select id="recent-adapter-filter" aria-label="Filter recent work by adapter"><option value="">All adapters</option></select>
            <input id="recent-search" type="search" autocomplete="off" placeholder="Search id, job, error">
          </div>
          <div id="recent-work"></div>
        </section>
      </section>
    </section>
  </main>

  <script>
    const STATUS_PATH = ${JSON.stringify(statusPath)};
    const AUTH_REQUIRED = ${boolAttr(options.authRequired)};
    const POLL_MS = 1000;
    const LIVE_TICK_MS = 250;
    const tokenPanel = document.getElementById('token-panel');
    const tokenInput = document.getElementById('token-input');
    const errorBanner = document.getElementById('error-banner');
    const lastUpdated = document.getElementById('last-updated');
    const toggle = document.getElementById('toggle-polling');
    const recentRuntimeFilter = document.getElementById('recent-runtime-filter');
    const recentStateFilter = document.getElementById('recent-state-filter');
    const recentSourceFilter = document.getElementById('recent-source-filter');
    const recentAdapterFilter = document.getElementById('recent-adapter-filter');
    const recentSearch = document.getElementById('recent-search');
    const tabLinks = Array.from(document.querySelectorAll('[data-tab]'));
    const tabPanels = Array.from(document.querySelectorAll('[data-tab-panel]'));
    const tabIds = tabLinks.map((link) => link.dataset.tab);
    let paused = false;
    let pollTimer = null;
    let liveTimer = null;
    let lastStatus = null;
    let lastStatusAt = 0;
    let requestSeq = 0;
    let requestInFlight = false;

    function text(value, fallback = '-') {
      if (value === undefined || value === null || value === '') return fallback;
      return String(value);
    }

    function normalizeTab(value) {
      return tabIds.includes(value) ? value : 'overview';
    }

    function setActiveTab(tab, updateHash = false) {
      const activeTab = normalizeTab(tab);
      tabLinks.forEach((link) => {
        const active = link.dataset.tab === activeTab;
        link.classList.toggle('active', active);
        link.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      tabPanels.forEach((panel) => {
        panel.classList.toggle('active', panel.dataset.tabPanel === activeTab);
      });
      if (updateHash && window.location.hash !== '#' + activeTab) {
        history.pushState(null, '', '#' + activeTab);
      }
    }

    function escapeHtml(value) {
      return text(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]);
    }

    function fmtMs(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
      if (value < 1000) return Math.round(value) + 'ms';
      const seconds = Math.floor(value / 1000);
      if (seconds < 60) return seconds + 's';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + 'm ' + (seconds % 60) + 's';
      const hours = Math.floor(minutes / 60);
      return hours + 'h ' + (minutes % 60) + 'm';
    }

    function fmtSeconds(value) {
      return fmtMs(typeof value === 'number' ? value * 1000 : null);
    }

    function fmtBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
      const units = ['B', 'KB', 'MB', 'GB'];
      let size = Math.max(0, value);
      let index = 0;
      while (size >= 1024 && index < units.length - 1) {
        size = size / 1024;
        index += 1;
      }
      const digits = size >= 10 || index === 0 ? 0 : 1;
      return size.toFixed(digits) + ' ' + units[index];
    }

    function fmtBps(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
      return fmtBytes(value) + '/s';
    }

    function fmtPercent(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
      return Math.round(Math.max(0, Math.min(1, value)) * 100) + '%';
    }

    function fmtTokenRatio(done, total) {
      if (typeof done !== 'number' || !Number.isFinite(done)) return '';
      if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) {
        return Math.round(done).toLocaleString() + ' tokens';
      }
      return Math.round(done).toLocaleString() + ' / ' + Math.round(total).toLocaleString() + ' tokens';
    }

    function stateClass(state) {
      return 'state-' + text(state, 'unknown').toLowerCase().replace(/[^a-z0-9_]+/g, '-');
    }

    function progressBar(value, cls = '') {
      const indeterminate = (value === undefined || value === null) && cls === 'loading';
      const percent = typeof value === 'number' && Number.isFinite(value)
        ? Math.round(Math.max(0, Math.min(1, value)) * 100)
        : 0;
      const title = indeterminate ? 'Actual load progress unavailable' : percent + '%';
      const delay = indeterminate ? -Math.round(Date.now() % 1150) : 0;
      return '<div class="progress ' + (indeterminate ? 'indeterminate' : '') + '" title="' + escapeHtml(title) + '"><div class="progress-bar ' + escapeHtml(cls) + '" style="' + (indeterminate ? 'animation-delay: ' + delay + 'ms' : 'width: ' + percent + '%') + '"></div></div>';
    }

    function metric(label, value, large = false, sub = '') {
      return '<article class="metric"><div class="label">' + escapeHtml(label) + '</div><div class="value ' + (large ? 'large' : '') + '" title="' + escapeHtml(value) + '">' + escapeHtml(value) + '</div>' + (sub ? '<div class="metric-sub">' + escapeHtml(sub) + '</div>' : '') + '</article>';
    }

    function activeItems(status) {
      return Array.isArray(status.active_work) ? status.active_work : [];
    }

    function queuedItems(status) {
      return Array.isArray(status.gpu_queue) ? status.gpu_queue.filter((item) => item.state === 'queued') : [];
    }

    function recentItems(status) {
      return Array.isArray(status.recent_work) ? status.recent_work : [];
    }

    function timelineItems(status) {
      return Array.isArray(status.runtime_timeline) ? status.runtime_timeline : [];
    }

    function uniqueValues(rows, key) {
      return Array.from(new Set(rows.map((row) => row[key]).filter((value) => value !== undefined && value !== null && value !== ''))).sort();
    }

    function syncSelectOptions(select, values, fallbackLabel) {
      const current = select.value;
      select.innerHTML = '<option value="">' + escapeHtml(fallbackLabel) + '</option>'
        + values.map((value) => '<option value="' + escapeHtml(value) + '">' + escapeHtml(phaseValue(value)) + '</option>').join('');
      select.value = values.includes(current) ? current : '';
    }

    function syncRecentFilters(rows) {
      syncSelectOptions(recentRuntimeFilter, uniqueValues(rows, 'runtimeAlias'), 'All runtimes');
      syncSelectOptions(recentStateFilter, uniqueValues(rows, 'state'), 'All states');
      syncSelectOptions(recentSourceFilter, uniqueValues(rows, 'source'), 'All sources');
      syncSelectOptions(recentAdapterFilter, uniqueValues(rows, 'runtimeAdapter'), 'All adapters');
    }

    function filteredRecentItems(status) {
      const query = recentSearch.value.trim().toLowerCase();
      return recentItems(status).filter((row) => {
        if (recentRuntimeFilter.value && row.runtimeAlias !== recentRuntimeFilter.value) return false;
        if (recentStateFilter.value && row.state !== recentStateFilter.value) return false;
        if (recentSourceFilter.value && row.source !== recentSourceFilter.value) return false;
        if (recentAdapterFilter.value && row.runtimeAdapter !== recentAdapterFilter.value) return false;
        if (!query) return true;
        return [
          row.id,
          row.publicJobId,
          row.runtimeAlias,
          row.runtimeAdapter,
          row.runtimeMode,
          row.state,
          row.failureCategory,
          row.errorText,
        ].some((value) => text(value, '').toLowerCase().includes(query));
      });
    }

    function telemetryTotals(status) {
      const active = activeItems(status);
      const loadingRuntime = Array.isArray(status.managed_runtimes)
        ? status.managed_runtimes.find((runtime) => runtime.state === 'loading')
        : null;
      const prefill = active.filter((item) => item.phase === 'prefill');
      const prefillWithProgress = prefill.filter((item) => typeof item.prefillProgress === 'number' && Number.isFinite(item.prefillProgress));
      const prefillProgress = prefillWithProgress.length
        ? prefillWithProgress.reduce((sum, item) => sum + item.prefillProgress, 0) / prefillWithProgress.length
        : null;
      const prefillInputDone = prefill.reduce((sum, item) => sum + (Number(item.prefillInputDone) || 0), 0);
      const prefillInputTotal = prefill.reduce((sum, item) => sum + (Number(item.prefillInputTotal) || 0), 0);
      return {
        bandwidthBps: active.reduce((sum, item) => sum + (Number(item.bandwidthBps) || 0), 0),
        loadingRuntime,
        prefillInputDone: prefillInputDone || null,
        prefillInputTotal: prefillInputTotal || null,
        prefillProgress,
        requestBytes: active.reduce((sum, item) => sum + (Number(item.requestBytes) || 0), 0),
        responseBytes: active.reduce((sum, item) => sum + (Number(item.responseBytes) || 0), 0),
        waitingForFirstByte: prefill.length,
      };
    }

    function renderSummary(status) {
      const active = activeItems(status).length;
      const queue = queuedItems(status).length;
      const totals = telemetryTotals(status);
      const loadingProgress = totals.loadingRuntime
        ? totals.loadingRuntime.loadProgressSource === 'progress_file'
          ? fmtPercent(totals.loadingRuntime.loadProgress) + ' actual'
          : 'progress unavailable'
        : 'idle';
      document.getElementById('summary').innerHTML = [
        metric('Loaded model', status.loaded_model ?? 'none'),
        metric('Loading model', status.loading_model ?? 'none', false, loadingProgress),
        metric('Active work', active, true),
        metric('Queued work', queue, true),
        metric('Throughput', fmtBps(totals.bandwidthBps), false, 'active upstream avg'),
        metric('Uptime', fmtSeconds(status.uptime_seconds)),
      ].join('');
    }

    function renderTelemetry(status) {
      const totals = telemetryTotals(status);
      const loading = totals.loadingRuntime;
      const prefillActual = typeof totals.prefillProgress === 'number';
      const prefillSub = prefillActual
        ? fmtPercent(totals.prefillProgress) + ' actual' + (fmtTokenRatio(totals.prefillInputDone, totals.prefillInputTotal) ? ' · ' + fmtTokenRatio(totals.prefillInputDone, totals.prefillInputTotal) : '')
        : totals.waitingForFirstByte
          ? 'waiting for runtime progress signal'
          : 'No active prefill.';
      document.getElementById('telemetry-strip').innerHTML = [
        '<article class="telemetry-card"><div class="label">Model load</div><strong>' + escapeHtml(loading ? loading.alias : 'No active load') + '</strong>'
          + progressBar(loading ? loading.loadProgress : 0, loading ? 'loading' : '')
          + '<p>' + escapeHtml(loading ? ((loading.loadPhase || 'loading') + ' · ' + fmtMs(loading.loadElapsedMs) + (loading.loadProgressSource === 'progress_file' ? ' · actual progress' : ' · no runtime progress signal')) : 'Loaded runtimes stay visible below.') + '</p></article>',
        '<article class="telemetry-card"><div class="label">Inference prefill</div><strong>' + escapeHtml(prefillActual ? fmtPercent(totals.prefillProgress) + ' prefill' : totals.waitingForFirstByte + ' waiting for first byte') + '</strong>'
          + progressBar(prefillActual ? totals.prefillProgress : totals.waitingForFirstByte ? null : 0, totals.waitingForFirstByte && !prefillActual ? 'loading' : prefillActual ? 'loading' : 'queued')
          + '<p>' + escapeHtml(prefillSub) + '</p></article>',
        '<article class="telemetry-card"><div class="label">Transfer</div><strong>' + escapeHtml(fmtBps(totals.bandwidthBps)) + '</strong>'
          + '<p>TX ' + escapeHtml(fmtBytes(totals.requestBytes)) + ' · RX ' + escapeHtml(fmtBytes(totals.responseBytes)) + '</p></article>',
      ].join('');
    }

    function renderRuntimes(runtimes) {
      const root = document.getElementById('runtimes');
      if (!Array.isArray(runtimes) || runtimes.length === 0) {
        root.innerHTML = '<div class="empty">No managed runtimes configured.</div>';
        return;
      }
      root.innerHTML = runtimes.map((runtime) => {
        const errors = [
          ['last error', runtime.lastError],
          ['load error', runtime.lastLoadError],
          ['upstream error', runtime.lastUpstreamError],
        ].filter(([, value]) => value);
        return '<article class="runtime-card">'
          + '<div class="runtime-head"><div class="runtime-name" title="' + escapeHtml(runtime.alias) + '">' + escapeHtml(runtime.alias) + '</div><span class="pill ' + stateClass(runtime.state) + '">' + escapeHtml(runtime.state) + '</span></div>'
          + progressBar(runtime.loadProgress, runtime.state)
          + '<div class="kv">'
          + '<span>enabled</span><span>' + escapeHtml(runtime.enabled) + '</span>'
          + '<span>active</span><span>' + escapeHtml(runtime.activeRequests) + ' / ' + escapeHtml(runtime.maxConcurrency) + '</span>'
          + '<span>queued</span><span>' + escapeHtml(runtime.queuedRequests) + '</span>'
          + '<span>load phase</span><span>' + escapeHtml(runtime.loadPhase) + '</span>'
          + '<span>progress</span><span>' + escapeHtml(runtime.loadProgressSource === 'progress_file' ? fmtPercent(runtime.loadProgress) + ' actual' : runtime.state === 'loading' ? 'not exposed' : fmtPercent(runtime.loadProgress)) + '</span>'
          + '<span>prefill</span><span>' + escapeHtml(typeof runtime.prefillProgress === 'number' ? fmtPercent(runtime.prefillProgress) + ' · ' + fmtTokenRatio(runtime.prefillInputDone, runtime.prefillInputTotal) : '-') + '</span>'
          + '<span>load elapsed</span><span>' + escapeHtml(fmtMs(runtime.loadElapsedMs)) + '</span>'
          + '<span>last used</span><span>' + escapeHtml(runtime.lastUsedAt) + '</span>'
          + '<span>upstream</span><span class="mono">' + escapeHtml(runtime.upstreamModel) + '</span>'
          + '</div>'
          + (errors.length ? '<div class="error-lines">' + errors.map(([label, value]) => '<div><strong>' + escapeHtml(label) + ':</strong> ' + escapeHtml(value) + '</div>').join('') + '</div>' : '')
          + '</article>';
      }).join('');
    }

    function renderTable(rootId, rows, columns, emptyText) {
      const root = document.getElementById(rootId);
      if (!Array.isArray(rows) || rows.length === 0) {
        root.innerHTML = '<div class="empty">' + escapeHtml(emptyText) + '</div>';
        return;
      }
      root.innerHTML = '<table><thead><tr>' + columns.map((column) => '<th>' + escapeHtml(column.label) + '</th>').join('') + '</tr></thead><tbody>'
        + rows.map((row) => '<tr>' + columns.map((column) => {
          const value = column.format ? column.format(row[column.key], row) : row[column.key];
          const compact = ['model', 'runtimeAlias', 'runtimeAdapter', 'runtimeMode', 'upstreamName', 'publicJobId', 'errorText', 'timing', 'transfer'].includes(column.key);
          const cls = column.key === 'id' ? ' class="id"' : compact ? ' class="compact"' : '';
          const title = column.key === 'id' || compact ? ' title="' + escapeHtml(value) + '"' : '';
          return '<td' + cls + title + '>' + escapeHtml(value) + '</td>';
        }).join('') + '</tr>').join('')
        + '</tbody></table>';
    }

    function phaseValue(value) {
      return text(value).replace(/_/g, ' ');
    }

    function fmtTiming(_value, row) {
      return 'age ' + fmtMs(row.ageMs) + ' · active ' + fmtMs(row.activeDurationMs);
    }

    function fmtTransfer(_value, row) {
      return 'TX ' + fmtBytes(row.requestBytes) + ' · RX ' + fmtBytes(row.responseBytes) + ' · ' + fmtBps(row.bandwidthBps);
    }

    function workField(label, value, className = '') {
      return '<div class="work-field ' + escapeHtml(className) + '"><span>' + escapeHtml(label) + '</span><strong title="' + escapeHtml(value) + '">' + escapeHtml(value) + '</strong></div>';
    }

    function renderActiveWork(rootId, rows) {
      const root = document.getElementById(rootId);
      if (!root) return;
      if (!Array.isArray(rows) || rows.length === 0) {
        root.innerHTML = '<div class="empty">No active GPU work.</div>';
        return;
      }
      root.innerHTML = '<div class="work-list">' + rows.map((row) => {
        const subtitle = [
          row.source,
          row.runtimeAlias,
          phaseValue(row.runtimeAdapter),
          phaseValue(row.runtimeMode),
        ].filter(Boolean).map((item) => escapeHtml(item)).join(' · ');
        return '<article class="work-card">'
          + '<div class="work-card-head">'
          + '<div class="work-title"><strong title="' + escapeHtml(row.id) + '">' + escapeHtml(row.id) + '</strong><span>' + subtitle + '</span></div>'
          + '<span class="pill ' + stateClass(row.phase || row.state) + '">' + escapeHtml(phaseValue(row.phase || row.state)) + '</span>'
          + '</div>'
          + '<div class="work-fields">'
          + workField('priority', row.priority)
          + workField('timing', fmtTiming(null, row))
          + workField('prefill', fmtPercent(row.prefillProgress))
          + workField('first byte', fmtMs(row.timeToFirstByteMs))
          + workField('transfer', fmtTransfer(null, row), 'wide')
          + workField('upstream', text(row.upstreamName))
          + workField('job', text(row.publicJobId))
          + '</div>'
          + '</article>';
      }).join('') + '</div>';
    }

    function renderTimeline(status) {
      const root = document.getElementById('runtime-timeline');
      const rows = timelineItems(status);
      if (!rows.length) {
        root.innerHTML = '<div class="empty">No runtime timeline events yet.</div>';
        return;
      }
      root.innerHTML = rows.map((row) => {
        const metadata = row.metadataJson ? safeJson(row.metadataJson) : null;
        const metaParts = [
          row.runtimeAlias,
          row.workItemId,
          row.source,
          row.state,
        ].filter(Boolean).map((item) => escapeHtml(item));
        return '<article class="timeline-event">'
          + '<div class="timeline-time">' + escapeHtml(new Date(row.createdAt).toLocaleTimeString()) + '</div>'
          + '<div class="timeline-message">'
          + '<span class="pill ' + stateClass(row.eventType) + '">' + escapeHtml(phaseValue(row.eventType)) + '</span> '
          + escapeHtml(row.message)
          + (metaParts.length ? '<div class="timeline-meta">' + metaParts.join(' · ') + '</div>' : '')
          + (metadata ? '<details><summary>details</summary><pre>' + escapeHtml(JSON.stringify(metadata, null, 2)) + '</pre></details>' : '')
          + '</div>'
          + '</article>';
      }).join('');
    }

    function safeJson(value) {
      try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) return null;
        return parsed;
      } catch {
        return null;
      }
    }

    function renderRecentWork(status) {
      const rows = filteredRecentItems(status);
      const root = document.getElementById('recent-work');
      if (!rows.length) {
        root.innerHTML = '<div class="empty">No matching completed GPU work.</div>';
        return;
      }
      root.innerHTML = '<table><thead><tr>'
        + ['id', 'source', 'runtime', 'adapter', 'mode', 'state', 'failure', 'duration', 'age', 'job', 'error'].map((label) => '<th>' + label + '</th>').join('')
        + '</tr></thead><tbody>'
        + rows.map((row) => {
          const error = text(row.errorText, '');
          const failure = row.failureCategory ? phaseValue(row.failureCategory) : '-';
          return '<tr>'
            + '<td class="id" title="' + escapeHtml(row.id) + '">' + escapeHtml(row.id) + '</td>'
            + '<td>' + escapeHtml(row.source) + '</td>'
            + '<td class="compact" title="' + escapeHtml(row.runtimeAlias) + '">' + escapeHtml(row.runtimeAlias) + '</td>'
            + '<td class="compact" title="' + escapeHtml(row.runtimeAdapter) + '">' + escapeHtml(phaseValue(row.runtimeAdapter)) + '</td>'
            + '<td class="compact" title="' + escapeHtml(row.runtimeMode) + '">' + escapeHtml(phaseValue(row.runtimeMode)) + '</td>'
            + '<td><span class="pill ' + stateClass(row.state) + '">' + escapeHtml(phaseValue(row.state)) + '</span></td>'
            + '<td>' + escapeHtml(failure) + '</td>'
            + '<td>' + escapeHtml(fmtMs(row.activeDurationMs)) + '</td>'
            + '<td>' + escapeHtml(fmtMs(row.ageMs)) + '</td>'
            + '<td class="compact" title="' + escapeHtml(row.publicJobId) + '">' + escapeHtml(row.publicJobId) + '</td>'
            + '<td class="compact" title="' + escapeHtml(error) + '">' + (error ? '<details><summary>error</summary><pre>' + escapeHtml(error) + '</pre></details>' : '-') + '</td>'
            + '</tr>';
        }).join('')
        + '</tbody></table>';
    }

    function renderWork(status) {
      renderActiveWork('active-work', status.active_work);
      renderActiveWork('queue-active-work', status.active_work);
      renderTable('gpu-queue', queuedItems(status), [
        { key: 'id', label: 'id' },
        { key: 'source', label: 'source' },
        { key: 'runtimeAlias', label: 'runtime' },
        { key: 'runtimeAdapter', label: 'adapter', format: phaseValue },
        { key: 'runtimeMode', label: 'mode', format: phaseValue },
        { key: 'phase', label: 'phase', format: phaseValue },
        { key: 'priority', label: 'priority' },
        { key: 'ageMs', label: 'age', format: fmtMs },
        { key: 'publicJobId', label: 'job' },
      ], 'No queued GPU work.');
      syncRecentFilters(recentItems(status));
      renderRecentWork(status);
    }

    function renderStatus(status) {
      renderSummary(status);
      renderTelemetry(status);
      renderRuntimes(status.managed_runtimes);
      renderTimeline(status);
      renderWork(status);
      updateLastUpdated();
    }

    function updateLastUpdated() {
      if (lastStatusAt) {
        lastUpdated.textContent = 'Updated ' + new Date(lastStatusAt).toLocaleTimeString();
      }
    }

    function showError(message) {
      errorBanner.textContent = message;
      errorBanner.classList.add('visible');
    }

    function clearError() {
      errorBanner.textContent = '';
      errorBanner.classList.remove('visible');
    }

    async function refreshStatus() {
      if (requestInFlight) return;
      requestInFlight = true;
      const seq = requestSeq + 1;
      requestSeq = seq;
      const headers = {};
      const token = sessionStorage.getItem('local-model-gateway-token') || '';
      if (token) headers.Authorization = 'Bearer ' + token;
      try {
        const separator = STATUS_PATH.includes('?') ? '&' : '?';
        const response = await fetch(STATUS_PATH + separator + 'recent_limit=50&timeline_limit=100', { cache: 'no-store', headers });
        if (seq !== requestSeq) return;
        if (response.status === 401) {
          tokenPanel.classList.add('visible');
          showError('Status request was rejected. Enter the bearer token to continue.');
          return;
        }
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const status = await response.json();
        clearError();
        lastStatus = status;
        lastStatusAt = Date.now();
        renderStatus(status);
      } catch (error) {
        showError('Could not refresh status: ' + (error instanceof Error ? error.message : String(error)));
      } finally {
        if (seq === requestSeq) requestInFlight = false;
      }
    }

    function schedule() {
      if (pollTimer) window.clearInterval(pollTimer);
      if (liveTimer) window.clearInterval(liveTimer);
      pollTimer = window.setInterval(() => {
        if (!paused) void refreshStatus();
      }, POLL_MS);
      liveTimer = window.setInterval(() => {
        if (paused) return;
        updateLastUpdated();
      }, LIVE_TICK_MS);
    }

    tokenInput.value = sessionStorage.getItem('local-model-gateway-token') || '';
    if (AUTH_REQUIRED) tokenPanel.classList.add('visible');
    tokenInput.addEventListener('input', () => {
      sessionStorage.setItem('local-model-gateway-token', tokenInput.value.trim());
      void refreshStatus();
    });
    [recentRuntimeFilter, recentStateFilter, recentSourceFilter, recentAdapterFilter, recentSearch].forEach((control) => {
      control.addEventListener('input', () => {
        if (lastStatus) renderWork(lastStatus);
      });
      control.addEventListener('change', () => {
        if (lastStatus) renderWork(lastStatus);
      });
    });
    tabLinks.forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        setActiveTab(link.dataset.tab, true);
      });
    });
    window.addEventListener('hashchange', () => {
      setActiveTab(normalizeTab(window.location.hash.slice(1)));
    });
    toggle.addEventListener('click', () => {
      paused = !paused;
      toggle.textContent = paused ? 'Resume' : 'Pause';
      if (!paused) void refreshStatus();
    });
    setActiveTab(normalizeTab(window.location.hash.slice(1)));
    void refreshStatus();
    schedule();
  </script>
</body>
</html>`;
}

export function registerDashboardRoute(app: Hono, authRequired: boolean): void {
  app.get('/dashboard', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.html(dashboardHtml({ authRequired }));
  });
}
