import { expect, test } from '@playwright/test';
import { argosScreenshot } from '@argos-ci/playwright';
import { readFileSync } from 'node:fs';
import { dashboardVisualScenarios, visualViewports } from '../../qa/visual/scenarios.js';
import { startVisualFixtureServer, type VisualFixtureServer } from '../../qa/visual/visual-server.js';

const argosCss = readFileSync(new URL('../../qa/visual/visual-mask.css', import.meta.url), 'utf8');

let fixtureServer: VisualFixtureServer;

test.beforeAll(async () => {
  fixtureServer = await startVisualFixtureServer();
});

test.afterAll(async () => {
  await fixtureServer.close();
});

for (const scenario of dashboardVisualScenarios) {
  for (const viewport of visualViewports) {
    const title = `dashboard ${scenario.id} ${viewport.name} @dashboard @${scenario.tab} @${viewport.name}`;

    test(title, async ({ page }, testInfo) => {
      testInfo.annotations.push({
        type: 'visual-review',
        description: scenario.review,
      });

      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`${fixtureServer.url}/dashboard?fixture=${scenario.fixture}#${scenario.tab}`, {
        waitUntil: 'domcontentloaded',
      });

      await expect(page.locator('[data-tab-panel].active')).toHaveAttribute('data-tab-panel', scenario.tab);

      if (scenario.expectAuthError) {
        await expect(page.locator('#error-banner')).toContainText('Status request was rejected');
      } else {
        await expect(page.locator('#summary .metric')).toHaveCount(6);
        await expect(page.locator('#last-updated')).toContainText('Updated');
      }

      await page.getByRole('button', { name: 'Pause' }).click();
      await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();

      await argosScreenshot(page, `dashboard/${scenario.id}/${viewport.name}`, {
        ariaSnapshot: viewport.name === 'desktop',
        fullPage: true,
        root: 'test-results/argos-screenshots',
        tag: ['dashboard', scenario.tab, viewport.name, ...scenario.tags],
        argosCSS: argosCss,
      });
    });
  }
}
