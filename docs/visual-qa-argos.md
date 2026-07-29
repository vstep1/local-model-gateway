# Argos Visual QA Setup

This project uses Argos for dashboard visual QA. Playwright is only the browser and screenshot driver; Argos owns the baseline, diff UI, review workflow, CI status, tags, annotations, and uploaded traces.

## 1. Why This Exists

The existing test suite already covers gateway behavior with node:test integration tests. It verifies HTTP routes, MCP tools, scheduler behavior, queueing, runtime state, and dashboard HTML structure. What it did not cover was whether the browser dashboard still looks usable across realistic gateway states and viewport sizes.

Visual QA fills that gap. It checks the UI states humans actually judge:

- empty dashboard
- healthy runtime
- runtime loading
- active and queued GPU work
- failed runtime
- dense history
- long model and job names
- auth-required status failure

## 2. Secret Handling

Do not commit an Argos token to this repository.

The GitHub workflow is configured for Argos GitHub OIDC. In Argos, enable GitHub OIDC under the project's authentication settings. The workflow grants `id-token: write`, so the Argos SDK can authenticate the CI run without a long-lived repository secret.

If token auth is needed for another CI provider, store the token in the CI secret manager as `ARGOS_TOKEN` and expose it only to the visual test step.

References:

- https://argos-ci.com/docs/quickstart/playwright-quickstart
- https://argos-ci.com/docs/sdks-reference/playwright
- https://argos-ci.com/docs/learn/integrations/github-oidc-authentication
- https://argos-ci.com/docs/learn/integrations/github-tokenless-authentication

## 3. Dependencies

The root workspace has two new dev dependencies:

- `@playwright/test`: runs Chromium and provides the browser automation layer.
- `@argos-ci/playwright`: captures stabilized screenshots, ARIA snapshots, metadata, failure screenshots, traces, and uploads to Argos on CI.

Installed with:

```bash
npm install -D @playwright/test @argos-ci/playwright
```

Chromium is installed separately:

```bash
npx playwright install chromium
```

CI uses:

```bash
npx playwright install --with-deps chromium
```

## 4. Configuration

Visual tests use `playwright.visual.config.ts` instead of the default test path.

Why:

- Keeps visual QA separate from fast node:test coverage.
- Uploads to Argos only when `CI` is set.
- Uses Chromium only for the initial baseline to reduce noise.
- Enables Playwright traces on retry and failure screenshots.
- Disables LCD text and font hinting to reduce font rendering diffs between local machines and CI.

Run locally:

```bash
npm run qa:visual
```

Debug with a visible browser:

```bash
npm run qa:visual:debug
```

## 5. Deterministic Fixtures

The dashboard normally polls live `/status`. Live runtime state is volatile, so visual tests do not start the real gateway.

Instead, `qa/visual/visual-server.ts` serves:

- the real `dashboardHtml(...)`
- a fixture-specific `statusPath`
- fixed JSON bodies from `qa/visual/fixtures/*.json`

This gives Argos stable visual states while still exercising the real dashboard HTML, CSS, and browser JavaScript.

## 6. Scenario Matrix

`qa/visual/scenarios.ts` defines the review scenarios and viewport matrix.

Current viewports:

- desktop: 1440 x 900
- laptop: 1280 x 800
- tablet: 768 x 1024
- mobile: 390 x 844

Each scenario includes a `visual-review` annotation. Argos displays those annotations so a QA reviewer sees what judgment the screenshot is supposed to support.

## 7. Stabilization

`qa/visual/visual-mask.css` is injected during Argos screenshot capture.

It disables transitions and animations, hides the live last-updated timestamp, and hides timeline clock text. Those values are not product UI decisions; they are runtime noise that would create false visual diffs.

The test also clicks `Pause` before capturing. That stops dashboard polling and live timestamp updates after the fixture has rendered.

## 8. What Argos Receives

Each screenshot is named:

```text
dashboard/<scenario>/<viewport>
```

Each screenshot is tagged with:

- `dashboard`
- active tab, such as `overview`, `queue`, `runtimes`, or `history`
- viewport name
- scenario-specific tags, such as `failure`, `dense`, or `overflow`

Desktop captures also include an ARIA snapshot. That adds accessibility structure to the Argos review without multiplying ARIA billing across every viewport.

## 9. GitHub Actions

`.github/workflows/visual-qa.yml` runs on:

- pull requests
- pushes to `main`
- merge queue runs

The workflow:

1. checks out the repo
2. installs Node 22 dependencies
3. builds packages
4. installs Chromium and Linux browser dependencies
5. runs `npm run qa:visual`

After the first successful run on `main`, Argos has the reference baseline. Pull requests then compare against that baseline.

## 10. QA Review Process

Manual QA should not maintain browser scripts. Their job is to review Argos builds and improve the scenario set.

They should ask:

- Does this state look trustworthy?
- Is the most important information visually dominant?
- Can the page be scanned under failure or queue pressure?
- Do long names truncate without breaking layout?
- Are redaction and auth states clear without leaking sensitive data?
- Which missing state needs a new fixture?

When they find a missing case, add a fixture under `qa/visual/fixtures`, add a scenario in `qa/visual/scenarios.ts`, and let Argos create the new baseline on `main`.
