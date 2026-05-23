import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Hono } from 'hono';
import { dashboardHtml, registerDashboardRoute } from '../src/dashboard.js';
import { publicGatewayPath } from '../src/server.js';

function authorized(request: Request, authToken: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  return header === `Bearer ${authToken}`;
}

describe('browser dashboard', () => {
  it('renders self-contained dashboard HTML with status polling', () => {
    const html = dashboardHtml({ authRequired: true });

    assert.match(html, /id="dashboard-root"/);
    assert.equal(html.includes('STATUS_PATH = "/status"'), true);
    assert.match(html, /POLL_MS = 1000/);
    assert.match(html, /LIVE_TICK_MS = 250/);
    assert.match(html, /cache: 'no-store'/);
    assert.match(html, /animation-delay: '\s*\+ delay \+ 'ms/);
    assert.match(html, /sessionStorage/);
    assert.match(html, /managed_runtimes/);
    assert.match(html, /gpu_queue/);
    assert.match(html, /recent_work/);
    assert.match(html, /renderTable\('gpu-queue', queuedItems\(status\)/);
    assert.match(html, /renderTable\('recent-work', recentItems\(status\)/);
    assert.match(html, /Model load/);
    assert.match(html, /Inference prefill/);
    assert.match(html, /Throughput/);
    assert.match(html, /Recent Work/);
    assert.match(html, /bandwidthBps/);
    assert.match(html, /prefillProgress/);
    assert.match(html, /prefillInputDone/);
    assert.match(html, /prefillInputTotal/);
    assert.match(html, /fmtTokenRatio/);
    assert.match(html, /Actual load progress unavailable/);
    assert.match(html, /no runtime progress signal/);
    assert.match(html, /runtimeAlias/);
    assert.match(html, /runtimeAdapter/);
    assert.match(html, /runtimeMode/);
    assert.match(html, /command-running/);
    assert.doesNotMatch(html, /function workType/);
    assert.doesNotMatch(html, /label: 'type'/);
    assert.doesNotMatch(html, /if \(status\) renderStatus\(status\)/);
    assert.doesNotMatch(html, /function liveStatus/);
  });

  it('allows dashboard without auth while keeping status protected', async () => {
    const credential = 'sample';
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (publicGatewayPath(c.req.path)) {
        await next();
        return;
      }
      if (!authorized(c.req.raw, credential)) {
        return c.json(
          { error: { message: 'Missing or invalid bearer token', type: 'authentication_error' } },
          401,
        );
      }
      await next();
    });

    registerDashboardRoute(app, true);
    app.get('/status', (c) => c.json({ service: 'local-model-gateway' }));

    const dashboard = await app.request('/dashboard');
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.headers.get('cache-control'), 'no-store');
    assert.match(await dashboard.text(), /Local Model Gateway Dashboard/);

    const unauthorizedStatus = await app.request('/status');
    assert.equal(unauthorizedStatus.status, 401);

    const authorizedStatus = await app.request('/status', {
      headers: { authorization: `Bearer ${credential}` },
    });
    assert.equal(authorizedStatus.status, 200);
  });
});
