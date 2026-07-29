export type DashboardVisualTab = 'overview' | 'runtimes' | 'queue' | 'history';

export interface DashboardVisualScenario {
  id: string;
  fixture: string;
  tab: DashboardVisualTab;
  review: string;
  expectAuthError?: boolean;
  tags: string[];
}

export const visualViewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

export const dashboardVisualScenarios: DashboardVisualScenario[] = [
  {
    id: 'empty-overview',
    fixture: 'empty-status',
    tab: 'overview',
    review: 'Verify the empty dashboard reads as calm, intentional, and not broken.',
    tags: ['empty', 'overview'],
  },
  {
    id: 'healthy-runtime-overview',
    fixture: 'healthy-runtime',
    tab: 'overview',
    review: 'Verify the happy path hierarchy: loaded model, no queue pressure, and useful recent activity.',
    tags: ['healthy', 'overview'],
  },
  {
    id: 'loading-runtime-overview',
    fixture: 'loading-runtime',
    tab: 'overview',
    review: 'Verify active model loading and prefill progress feel legible without implying fake precision.',
    tags: ['loading', 'overview'],
  },
  {
    id: 'queued-work',
    fixture: 'queued-work',
    tab: 'queue',
    review: 'Verify active and queued GPU work can be scanned quickly under pressure.',
    tags: ['queue', 'active-work'],
  },
  {
    id: 'failed-runtime',
    fixture: 'failed-runtime',
    tab: 'runtimes',
    review: 'Verify failure states are visible, specific, and not visually overwhelming.',
    tags: ['failure', 'runtimes'],
  },
  {
    id: 'dense-history',
    fixture: 'dense-history',
    tab: 'history',
    review: 'Verify dense recent work and timeline tables remain readable and filterable.',
    tags: ['history', 'dense'],
  },
  {
    id: 'long-model-names',
    fixture: 'long-model-names',
    tab: 'runtimes',
    review: 'Verify long aliases, adapters, upstream names, and job IDs truncate cleanly.',
    tags: ['overflow', 'runtimes'],
  },
  {
    id: 'auth-required',
    fixture: 'auth-required',
    tab: 'overview',
    review: 'Verify the protected status state explains what happened without exposing secrets.',
    expectAuthError: true,
    tags: ['auth', 'error'],
  },
];
