# Target QA Process

This document defines the target QA process for feature work, bug fixes, and release candidates. It is intentionally generic: it describes how QA should operate before binding the process to any one tool, CI provider, visual testing vendor, or agent framework.

The process assumes a human QA owner supported by automated tests, visual review, AI exploratory agents, and a live preview environment. The human remains the final judge of product quality.

## 1. Purpose

The purpose of QA is to answer one question:

> Can this change ship without surprising users, breaking expected behavior, or degrading the product experience?

QA is not just "run the tests." Automated tests catch known contracts. Visual tools catch visible drift. AI agents explore and summarize likely issues. Human QA decides whether the behavior, feel, and product outcome are acceptable.

## 2. Core Principles

- QA starts from the ticket, not from the implementation.
- Every QA run has a named owner and a written decision.
- Automation gathers evidence in parallel; humans review the important evidence.
- AI agents can investigate, compare, and recommend, but they do not silently approve.
- Human review is event-driven: QA steps in when a lane is ready, blocked, or asking for judgment.
- Every escaped bug or repeated manual check should become a future automated check, visual scenario, fixture, or QA charter.
- A change is not ready to merge until product intent, functional behavior, visual quality, and regression risk have all been addressed.

## 3. Roles

### Developer

The developer owns the implementation and prepares the change for QA. They must provide enough context for QA to test the feature without reverse-engineering intent from code.

Developer responsibilities:

- Link the ticket, PR, and preview environment.
- Explain what changed and why.
- State acceptance criteria.
- Call out known risks, known gaps, and expected visual changes.
- Provide test data, credentials, flags, or setup steps.
- Fix or explain QA findings.

### QA Owner

The QA owner runs the QA process and makes the human judgment calls. They do not need to write automation for every change, but they do own the quality decision.

QA owner responsibilities:

- Verify the handoff is testable.
- Start the QA run.
- Monitor automated and AI-assisted lanes.
- Review flagged findings.
- Perform manual checks where human judgment matters.
- Approve, block, or request follow-up.
- Convert repeated or escaped manual checks into durable future coverage requests.

### AI QA Agent

AI QA agents run scoped investigations in parallel. They are evidence collectors and first-pass analysts.

Agent responsibilities:

- Execute a specific charter.
- Open the preview or local build.
- Exercise the relevant flows.
- Compare expected and actual behavior.
- Capture screenshots, traces, console errors, network failures, and reproduction steps.
- Produce a short review packet.
- Stop and flag QA when human judgment is required.

### Reviewer Or Release Owner

The reviewer or release owner enforces merge and release policy.

Reviewer responsibilities:

- Ensure required checks passed.
- Confirm QA sign-off is recorded.
- Confirm unresolved blockers are not bypassed.
- Approve intentional visual or behavioral changes when product ownership is needed.

## 4. QA Artifacts

Every QA run should produce or link to these artifacts:

- Source ticket.
- PR or branch.
- Preview URL or local preview command.
- Acceptance criteria.
- Automated test results.
- Visual review result.
- AI exploratory report.
- Manual QA notes.
- Defects or follow-up tickets.
- Final QA decision.

The final QA decision must be one of:

- `approved`
- `approved-with-follow-ups`
- `blocked`
- `needs-developer-clarification`
- `not-testable`

## 5. QA Handoff Requirements

A developer can hand a feature to QA only when the following information exists:

- Ticket link.
- PR or branch link.
- Short summary of the change.
- User-facing behavior being added, changed, or removed.
- Acceptance criteria.
- Preview URL or exact local command to open the feature.
- Test account, fixture, seed data, or setup steps.
- Feature flags or environment variables.
- Expected visual changes.
- Known limitations or intentionally deferred work.
- Areas most likely to regress.
- Any data privacy, auth, payment, destructive action, or permission risk.

If any required item is missing, QA may mark the handoff `not-testable` and return it to the developer before starting deeper review.

## 6. Developer QA Request Template

Developers should use this template when moving work to `Ready for QA`.

```text
QA request

Ticket:
PR or branch:
Preview URL or local command:

Summary:
- What changed?

User impact:
- Who is affected?
- What can they do now that they could not do before?
- What behavior changed?

Acceptance criteria:
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

How to test:
- Setup:
- Test data:
- Accounts or permissions:
- Feature flags or environment variables:

Expected visual changes:
- None / list changes

Risk notes:
- Areas likely to regress:
- Known limitations:
- Deferred follow-ups:

Developer self-check:
- [ ] Build passes
- [ ] Unit/integration tests pass
- [ ] Main happy path checked locally
- [ ] Obvious failure or empty state checked
```

## 7. QA Run Record Template

QA should keep one run record per feature, bug fix, or release candidate.

```text
QA run

Status:
- in-progress | approved | approved-with-follow-ups | blocked | not-testable

Scope:
- Ticket:
- PR or branch:
- Preview:
- QA owner:
- Date:

Lanes run:
- [ ] Automated regression
- [ ] Visual review
- [ ] AI exploratory
- [ ] Baseline comparison
- [ ] Manual review

Agent checkpoints:
- Lane:
- Status:
- Finding:
- Human decision:

Manual review notes:
- Acceptance criteria:
- Happy path:
- Failure or empty states:
- Mobile or constrained layout:
- Visual changes:
- Product feel:

Findings:
- Finding link or summary:
- Severity:
- Blocks merge:
- Owner:

Final decision:
- Decision:
- Reason:
- Required follow-ups:
```

## 8. QA Run Types

### Feature QA

Used when a developer says: "Here is the ticket and feature. Please test it."

Goal:

- Verify the implementation satisfies the ticket.
- Verify the changed flow works in realistic usage.
- Verify the product still feels coherent.
- Identify missing tests, missing visual scenarios, and unclear requirements.

### Bug Fix Verification

Used when a PR claims to fix a known defect.

Goal:

- Reproduce the original bug on a baseline build when practical.
- Verify the bug is fixed on the PR build.
- Check for nearby regressions.
- Add or request durable coverage so the bug does not return.

### Release Candidate Regression

Used before a major release or high-risk deploy.

Goal:

- Re-run broad regression coverage.
- Exercise high-risk workflows in parallel.
- Review all visual changes since the last release.
- Confirm install, upgrade, rollback, and failure states.
- Produce a release sign-off decision.

### Hotfix QA

Used for urgent production fixes.

Goal:

- Validate the narrow fix quickly.
- Check the highest-risk adjacent behavior.
- Record what was intentionally not tested because of urgency.
- Create follow-up regression coverage after the hotfix ships.

## 9. Feature QA Process

### Step 1: Developer Requests QA

The developer moves the ticket or PR to `Ready for QA` and provides the handoff requirements.

The request should answer:

- What changed?
- Why did it change?
- How should QA open it?
- What should be true when it works?
- What risks should QA pay attention to?

### Step 2: QA Performs Intake

QA checks whether the handoff is testable.

If the handoff is incomplete, QA returns it with a short reason:

```text
Not testable yet:
- Missing preview URL
- No test account for auth-required flow
- Acceptance criteria do not describe expected empty state
```

If the handoff is complete, QA starts a QA run.

### Step 3: QA Starts Parallel Lanes

QA opens the work in parallel lanes. Each lane has a charter and produces a result.

Recommended lanes:

| Lane | Purpose | Typical Output |
| --- | --- | --- |
| Automated regression | Verify known contracts still pass | Pass/fail summary |
| Visual review | Identify visible UI drift | Changed screenshots and approval status |
| AI exploratory | Exercise the feature like a user | Review packet with evidence |
| Baseline comparison | Compare PR behavior against main or last release | Differences requiring review |
| Manual review | Human product judgment | Final QA decision |

Not every PR needs every lane. Small backend-only changes may skip visual review. High-risk UI changes should run all lanes.

### Step 4: Agents Run Until They Reach A Checkpoint

Agents should not produce long transcripts as their primary output. Each agent produces a review packet.

Review packet format:

```text
Status: passed | failed | blocked | needs-human-review

Charter:
- What the agent was asked to test

What I tested:
- Concrete flows, states, viewports, data, or commands

Findings:
- Clear issues or "no issues found"

Evidence:
- Preview URL
- Screenshots or traces
- Console and network notes
- Reproduction steps

Human decision needed:
- The specific judgment QA must make, if any
```

Agents flag QA when:

- A flow appears broken.
- The UI works but feels confusing.
- Behavior differs from the ticket.
- Behavior differs from the baseline.
- The agent found console or network errors.
- The agent cannot continue because setup or credentials are missing.
- The issue is subjective and requires product judgment.

### Step 5: QA Reviews Flagged Packets

QA works from the flag queue, not from every raw log.

For each flagged packet, QA decides:

- `accept`: finding is acceptable or intentional.
- `block`: finding prevents merge.
- `ask-dev`: developer context is required.
- `needs-test`: add or request deterministic coverage.
- `needs-visual-scenario`: add or request visual coverage.
- `needs-agent-follow-up`: ask the agent to investigate more narrowly.

QA should open the preview and reproduce the issue manually before blocking unless the evidence is already decisive.

### Step 6: QA Performs Manual Review

Manual review focuses on human judgment:

- Does the feature satisfy the ticket?
- Does the workflow feel understandable?
- Are labels, hierarchy, and empty states clear?
- Does the UI still work under realistic data?
- Are failure states understandable?
- Are permissions, auth, privacy, and destructive actions safe?
- Does mobile or constrained layout remain usable?
- Are expected visual changes actually intentional?

Manual QA should avoid repeating checks that automation has already proved unless the check requires taste, context, or user empathy.

### Step 7: QA Records Findings

Findings should be actionable and reproducible.

Use this format:

```text
Title:
Impact:
Environment:
Steps to reproduce:
Expected:
Actual:
Evidence:
Suggested severity:
Blocks merge: yes/no
```

Severity guide:

- `blocker`: cannot ship; core flow broken, data loss, auth/privacy issue, crash, or severe regression.
- `high`: important user-facing behavior broken, but workaround may exist.
- `medium`: degraded UX, confusing behavior, or secondary flow issue.
- `low`: polish, copy, minor layout, or non-blocking inconsistency.

### Step 8: Developer Responds

For each blocking or requested-change finding, the developer does one of:

- Fixes the issue.
- Explains why the behavior is intentional.
- Updates the ticket or acceptance criteria.
- Splits the issue into a follow-up ticket with QA/product approval.

After a fix, QA reruns only the affected lanes unless the change is broad enough to require a full rerun.

### Step 9: QA Signs Off

QA can approve when:

- Acceptance criteria are satisfied.
- Required automated checks passed.
- Visual changes are approved or there are no visual changes.
- AI exploratory blockers are resolved or accepted.
- Manual review found no unresolved blocking issues.
- Follow-ups are documented and accepted by the appropriate owner.

QA records the final decision:

```text
QA decision: approved
Scope reviewed:
- Ticket acceptance criteria
- Visual changes
- Functional smoke
- Mobile layout
- Failure state

Known follow-ups:
- Add durable regression test for auth timeout
```

## 10. Release Candidate QA Process

Release candidate QA uses the same model but expands the lanes.

Recommended release lanes:

| Lane | Purpose |
| --- | --- |
| Full regression | Run the complete automated test suite |
| Visual sweep | Review all visual diffs since the previous baseline |
| Install and upgrade | Verify clean install, upgrade, config migration, and startup |
| Core workflows | Exercise the main user journeys |
| Failure recovery | Verify error states, unavailable dependencies, retries, and recovery |
| Auth and permissions | Verify access control and protected states |
| Mobile and responsive | Verify constrained viewport behavior |
| Baseline comparison | Compare release candidate against the last stable release |
| Documentation check | Verify user-facing docs match the release |
| Manual sign-off | Human release approval |

Release exit criteria:

- No failing required automated checks.
- No unapproved visual diffs.
- No unresolved blocker or high-severity QA findings.
- Install and upgrade paths pass.
- Release notes or docs cover user-visible changes.
- QA owner signs off.
- Release owner signs off.

## 11. Human Checkpoint Model

The target process is event-driven.

QA does not need to watch every agent work. QA watches for checkpoints:

- `passed`: no action unless QA wants to spot-check.
- `failed`: review evidence and decide whether it blocks.
- `blocked`: provide missing input or return to developer.
- `needs-human-review`: inspect the preview and make a judgment.

Human checkpoint prompt:

```text
Needs human review

Area:
- Mobile dashboard queue view

Question:
- Is the compressed job metadata acceptable, or should this block the PR?

Evidence:
- Screenshot
- Preview URL
- Reproduction steps

Recommended action:
- Manual review in mobile viewport
```

## 12. Merge Policy

A PR can merge only when:

- Required CI checks pass.
- Required visual review is approved.
- QA has signed off or explicitly marked QA as not required.
- No unresolved blocker findings remain.
- Known follow-ups are documented and accepted.
- Product owner has approved any intentional behavior change that deviates from the ticket.

Emergency exceptions require written release owner approval and a follow-up ticket.

## 13. What QA Should Learn And Improve

QA should improve the system after each meaningful finding.

When QA finds a bug, ask:

- Should this become an automated functional test?
- Should this become a visual scenario?
- Should this become an AI exploratory charter?
- Should the ticket template include this context next time?
- Should the developer handoff requirements change?

The goal is not to remove human QA. The goal is to make human QA spend more time on product judgment and less time rediscovering known checks.

## 14. Minimal Feature QA Checklist

Use this checklist for ordinary feature handoffs:

- Handoff is complete.
- Preview opens.
- Acceptance criteria verified.
- Main happy path works.
- Important failure or empty state works.
- Visual review completed if UI changed.
- Mobile or constrained layout checked if UI changed.
- AI exploratory report reviewed if enabled.
- Blocking findings resolved.
- Follow-ups documented.
- QA decision recorded.
