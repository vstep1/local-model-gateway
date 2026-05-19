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
    assert.match(html, /POLL_MS = 1500/);
    assert.match(html, /sessionStorage/);
    assert.match(html, /managed_runtimes/);
    assert.match(html, /gpu_queue/);
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
    assert.match(await dashboard.text(), /Local Model Gateway Dashboard/);

    const unauthorizedStatus = await app.request('/status');
    assert.equal(unauthorizedStatus.status, 401);

    const authorizedStatus = await app.request('/status', {
      headers: { authorization: `Bearer ${credential}` },
    });
    assert.equal(authorizedStatus.status, 200);
  });
});
