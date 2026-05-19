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
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
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
    h1 { font-size: clamp(2rem, 4vw, 3.8rem); line-height: 1; margin: 0 0 10px; letter-spacing: 0; }
    h2 { font-size: 1rem; margin: 0 0 14px; color: #cbd5e1; font-weight: 700; }
    p { margin: 0; color: var(--muted); }
    button, input {
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
    .controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
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
      grid-template-columns: repeat(5, minmax(0, 1fr));
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
    .value { font-family: Menlo, Consolas, ui-monospace, monospace; font-size: 1.03rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .value.large { font-size: 1.35rem; font-weight: 700; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .panel { padding: 16px; overflow: hidden; }
    .runtime-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
    .runtime-card { padding: 14px; }
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
    .state-loading { background: var(--blue); }
    .state-queued { background: var(--amber); }
    .state-failed, .state-timed_out, .state-cancelled { background: var(--red); }
    .state-unloading { background: var(--purple); }
    .kv { display: grid; grid-template-columns: 120px 1fr; gap: 6px 10px; font-size: 0.88rem; }
    .kv span:nth-child(odd) { color: var(--muted); }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    th, td { padding: 9px 8px; border-bottom: 1px solid rgba(148, 163, 184, 0.18); text-align: left; vertical-align: top; }
    th { color: #d4d8dc; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0; }
    td.id { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .empty { color: var(--muted); padding: 18px 0; }
    .last-updated { color: var(--muted); font-size: 0.88rem; }
    .error-lines { margin-top: 10px; color: #fecdd3; font-size: 0.84rem; display: grid; gap: 4px; }
    @media (max-width: 900px) {
      header { display: block; }
      .controls { justify-content: flex-start; margin-top: 18px; }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main id="dashboard-root">
    <header>
      <div>
        <h1>Local Model Gateway</h1>
        <p>Runtime residency and GPU queue status.</p>
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

    <section class="panel" style="margin-bottom: 16px;">
      <h2>Managed Runtimes</h2>
      <div class="runtime-grid" id="runtimes"></div>
    </section>

    <section class="grid">
      <section class="panel">
        <h2>Active Work</h2>
        <div id="active-work"></div>
      </section>
      <section class="panel">
        <h2>GPU Queue</h2>
        <div id="gpu-queue"></div>
      </section>
    </section>
  </main>

  <script>
    const STATUS_PATH = ${JSON.stringify(statusPath)};
    const AUTH_REQUIRED = ${boolAttr(options.authRequired)};
    const POLL_MS = 1500;
    const tokenPanel = document.getElementById('token-panel');
    const tokenInput = document.getElementById('token-input');
    const errorBanner = document.getElementById('error-banner');
    const lastUpdated = document.getElementById('last-updated');
    const toggle = document.getElementById('toggle-polling');
    let paused = false;
    let timer = null;

    function text(value, fallback = '-') {
      if (value === undefined || value === null || value === '') return fallback;
      return String(value);
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

    function stateClass(state) {
      return 'state-' + text(state, 'unknown').toLowerCase().replace(/[^a-z0-9_]+/g, '-');
    }

    function metric(label, value, large = false) {
      return '<article class="metric"><div class="label">' + escapeHtml(label) + '</div><div class="value ' + (large ? 'large' : '') + '" title="' + escapeHtml(value) + '">' + escapeHtml(value) + '</div></article>';
    }

    function renderSummary(status) {
      const active = Array.isArray(status.active_work) ? status.active_work.length : 0;
      const queue = Array.isArray(status.gpu_queue) ? status.gpu_queue.filter((item) => item.state === 'queued').length : 0;
      document.getElementById('summary').innerHTML = [
        metric('Loaded model', status.loaded_model ?? 'none'),
        metric('Loading model', status.loading_model ?? 'none'),
        metric('Active work', active, true),
        metric('Queued work', queue, true),
        metric('Uptime', fmtSeconds(status.uptime_seconds)),
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
          + '<div class="kv">'
          + '<span>enabled</span><span>' + escapeHtml(runtime.enabled) + '</span>'
          + '<span>active</span><span>' + escapeHtml(runtime.activeRequests) + ' / ' + escapeHtml(runtime.maxConcurrency) + '</span>'
          + '<span>queued</span><span>' + escapeHtml(runtime.queuedRequests) + '</span>'
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
          const cls = column.key === 'id' ? ' class="id"' : '';
          const title = column.key === 'id' ? ' title="' + escapeHtml(value) + '"' : '';
          return '<td' + cls + title + '>' + escapeHtml(value) + '</td>';
        }).join('') + '</tr>').join('')
        + '</tbody></table>';
    }

    function workType(value, row) {
      return row.type ?? row.kind ?? value;
    }

    function renderWork(status) {
      renderTable('active-work', status.active_work, [
        { key: 'id', label: 'id' },
        { key: 'source', label: 'source' },
        { key: 'model', label: 'model' },
        { key: 'priority', label: 'priority' },
        { key: 'state', label: 'state' },
        { key: 'ageMs', label: 'age', format: fmtMs },
        { key: 'activeDurationMs', label: 'active', format: fmtMs },
        { key: 'publicJobId', label: 'job' },
        { key: 'type', label: 'type', format: workType },
      ], 'No active GPU work.');
      renderTable('gpu-queue', status.gpu_queue, [
        { key: 'id', label: 'id' },
        { key: 'source', label: 'source' },
        { key: 'model', label: 'model' },
        { key: 'priority', label: 'priority' },
        { key: 'state', label: 'state' },
        { key: 'ageMs', label: 'age', format: fmtMs },
        { key: 'publicJobId', label: 'job' },
        { key: 'type', label: 'type', format: workType },
      ], 'No queued GPU work.');
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
      const headers = {};
      const token = sessionStorage.getItem('local-model-gateway-token') || '';
      if (token) headers.Authorization = 'Bearer ' + token;
      try {
        const response = await fetch(STATUS_PATH, { headers });
        if (response.status === 401) {
          tokenPanel.classList.add('visible');
          showError('Status request was rejected. Enter the bearer token to continue.');
          return;
        }
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const status = await response.json();
        clearError();
        renderSummary(status);
        renderRuntimes(status.managed_runtimes);
        renderWork(status);
        lastUpdated.textContent = 'Updated ' + new Date().toLocaleTimeString();
      } catch (error) {
        showError('Could not refresh status: ' + (error instanceof Error ? error.message : String(error)));
      }
    }

    function schedule() {
      if (timer) window.clearInterval(timer);
      timer = window.setInterval(() => {
        if (!paused) void refreshStatus();
      }, POLL_MS);
    }

    tokenInput.value = sessionStorage.getItem('local-model-gateway-token') || '';
    if (AUTH_REQUIRED) tokenPanel.classList.add('visible');
    tokenInput.addEventListener('input', () => {
      sessionStorage.setItem('local-model-gateway-token', tokenInput.value.trim());
      void refreshStatus();
    });
    toggle.addEventListener('click', () => {
      paused = !paused;
      toggle.textContent = paused ? 'Resume' : 'Pause';
      if (!paused) void refreshStatus();
    });
    void refreshStatus();
    schedule();
  </script>
</body>
</html>`;
}

export function registerDashboardRoute(app: Hono, authRequired: boolean): void {
  app.get('/dashboard', (c) => c.html(dashboardHtml({ authRequired })));
}
