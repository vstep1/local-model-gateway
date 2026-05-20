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
    .metric, .panel, .runtime-card, .telemetry-card { min-width: 0; }
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
    .state-loading { background: var(--blue); }
    .state-prefill, .state-admitted, .state-loading-model { background: var(--blue); }
    .state-streaming, .state-receiving { background: var(--green); }
    .state-queued { background: var(--amber); }
    .state-failed, .state-timed_out, .state-cancelled { background: var(--red); }
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
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    #active-work, #gpu-queue { overflow-x: auto; padding-bottom: 4px; }
    #active-work table { min-width: 980px; }
    #gpu-queue table { min-width: 680px; }
    th, td { padding: 9px 8px; border-bottom: 1px solid rgba(148, 163, 184, 0.18); text-align: left; vertical-align: top; }
    th { color: #d4d8dc; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0; }
    td.id { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    td.compact { max-width: 105px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .empty { color: var(--muted); padding: 18px 0; }
    .last-updated { color: var(--muted); font-size: 0.88rem; }
    .error-lines { margin-top: 10px; color: #fecdd3; font-size: 0.84rem; display: grid; gap: 4px; }
    @keyframes indeterminate {
      0% { transform: translateX(-120%); }
      100% { transform: translateX(270%); }
    }
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

    <section class="telemetry-strip" id="telemetry-strip"></section>

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
    const POLL_MS = 1000;
    const LIVE_TICK_MS = 250;
    const tokenPanel = document.getElementById('token-panel');
    const tokenInput = document.getElementById('token-input');
    const errorBanner = document.getElementById('error-banner');
    const lastUpdated = document.getElementById('last-updated');
    const toggle = document.getElementById('toggle-polling');
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

    function telemetryTotals(status) {
      const active = activeItems(status);
      const loadingRuntime = Array.isArray(status.managed_runtimes)
        ? status.managed_runtimes.find((runtime) => runtime.state === 'loading')
        : null;
      return {
        bandwidthBps: active.reduce((sum, item) => sum + (Number(item.bandwidthBps) || 0), 0),
        loadingRuntime,
        requestBytes: active.reduce((sum, item) => sum + (Number(item.requestBytes) || 0), 0),
        responseBytes: active.reduce((sum, item) => sum + (Number(item.responseBytes) || 0), 0),
        waitingForFirstByte: active.filter((item) => item.phase === 'prefill').length,
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
      document.getElementById('telemetry-strip').innerHTML = [
        '<article class="telemetry-card"><div class="label">Model load</div><strong>' + escapeHtml(loading ? loading.alias : 'No active load') + '</strong>'
          + progressBar(loading ? loading.loadProgress : 0, loading ? 'loading' : '')
          + '<p>' + escapeHtml(loading ? ((loading.loadPhase || 'loading') + ' · ' + fmtMs(loading.loadElapsedMs) + (loading.loadProgressSource === 'progress_file' ? ' · actual progress' : ' · no runtime progress signal')) : 'Loaded runtimes stay visible below.') + '</p></article>',
        '<article class="telemetry-card"><div class="label">Inference prefill</div><strong>' + escapeHtml(totals.waitingForFirstByte + ' waiting for first byte') + '</strong>'
          + progressBar(activeItems(status).length ? Math.max(0.05, totals.waitingForFirstByte / activeItems(status).length) : 0, 'queued')
          + '<p>Requests in prefill have reached the runtime but have not streamed output yet.</p></article>',
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
          const cls = column.key === 'id' ? ' class="id"' : ['model', 'upstreamName', 'publicJobId'].includes(column.key) ? ' class="compact"' : '';
          const title = column.key === 'id' ? ' title="' + escapeHtml(value) + '"' : '';
          return '<td' + cls + title + '>' + escapeHtml(value) + '</td>';
        }).join('') + '</tr>').join('')
        + '</tbody></table>';
    }

    function workType(value, row) {
      return row.type ?? row.kind ?? value;
    }

    function phaseValue(value) {
      return text(value).replace(/_/g, ' ');
    }

    function renderWork(status) {
      renderTable('active-work', status.active_work, [
        { key: 'id', label: 'id' },
        { key: 'source', label: 'source' },
        { key: 'model', label: 'model' },
        { key: 'phase', label: 'phase', format: phaseValue },
        { key: 'priority', label: 'priority' },
        { key: 'ageMs', label: 'age', format: fmtMs },
        { key: 'activeDurationMs', label: 'active', format: fmtMs },
        { key: 'timeToFirstByteMs', label: 'first byte', format: fmtMs },
        { key: 'requestBytes', label: 'tx', format: fmtBytes },
        { key: 'responseBytes', label: 'rx', format: fmtBytes },
        { key: 'bandwidthBps', label: 'rate', format: fmtBps },
        { key: 'upstreamName', label: 'upstream' },
        { key: 'publicJobId', label: 'job' },
        { key: 'type', label: 'type', format: workType },
      ], 'No active GPU work.');
      renderTable('gpu-queue', queuedItems(status), [
        { key: 'id', label: 'id' },
        { key: 'source', label: 'source' },
        { key: 'model', label: 'model' },
        { key: 'phase', label: 'phase', format: phaseValue },
        { key: 'priority', label: 'priority' },
        { key: 'ageMs', label: 'age', format: fmtMs },
        { key: 'publicJobId', label: 'job' },
        { key: 'type', label: 'type', format: workType },
      ], 'No queued GPU work.');
    }

    function renderStatus(status) {
      renderSummary(status);
      renderTelemetry(status);
      renderRuntimes(status.managed_runtimes);
      renderWork(status);
      updateLastUpdated();
    }

    function updateLastUpdated() {
      if (lastStatusAt) {
        const age = Math.max(0, Date.now() - lastStatusAt);
        lastUpdated.textContent = 'Updated ' + new Date(lastStatusAt).toLocaleTimeString() + ' · ' + fmtMs(age) + ' ago';
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
        const response = await fetch(STATUS_PATH, { cache: 'no-store', headers });
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
  app.get('/dashboard', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.html(dashboardHtml({ authRequired }));
  });
}
