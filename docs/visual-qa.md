# Local Visual QA

The dashboard visual suite runs the real dashboard HTML, CSS, and browser
JavaScript against deterministic fixture responses. It covers eight gateway
states at four viewport sizes, for 32 Playwright scenarios in total:

- empty, healthy, and loading runtime overviews
- queued work
- failed runtimes
- dense history
- long model names
- an auth-required status failure

The suite does not start the gateway or any model runtime.

## Run locally

Use Node.js 22, then install the workspace and Chromium once:

```bash
npm ci
npx playwright install chromium
```

Run the suite with the normal reporter:

```bash
npm run qa:visual
```

For an interactive browser:

```bash
npm run qa:visual:debug
```

Each scenario pauses dashboard polling and captures a stabilized, full-page
PNG. The screenshot is attached to that test in the Playwright HTML report.
The report is written to `playwright-report/`; test output and attachments are
written under `test-results/`.

The screenshot style in `qa/visual/visual-mask.css` is injected through
Playwright's screenshot API. It disables animation and transition timing and
hides volatile timestamps so reviewers see comparable states without changing
the product page during normal use.

## CI artifacts and review

The GitHub workflow runs the same command with CI settings, then uploads
`playwright-report/` and `test-results/` as a workflow artifact after both
successful and failed test runs. The workflow only needs `contents: read` and
does not require a third-party visual service or credentials.

There is no automatic pixel comparison or remote baseline in this repository.
Review the attached screenshots and the HTML report for layout regressions,
truncation, hierarchy, and state clarity. Add a fixture in
`qa/visual/fixtures/` and a scenario in `qa/visual/scenarios.ts` when a new
state needs coverage.
