const SECRET_KEY_RE = /(authorization|bearer|token|secret|password|api[_-]?key|access[_-]?key|client[_-]?secret)/i;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;
const USER_PATH_RE = /\/Users\/[^/\s"]+/g;
const HOME_PATH_RE = /\/home\/[^/\s"]+/g;

export function redactString(value: string): string {
  return value
    .replace(BEARER_RE, 'Bearer [REDACTED]')
    .replace(USER_PATH_RE, '/Users/[REDACTED]')
    .replace(HOME_PATH_RE, '/home/[REDACTED]');
}

export function redactForStatus<T>(value: T): T {
  if (typeof value === 'string') {
    return redactString(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactForStatus(item)) as T;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_RE.test(key) ? '[REDACTED]' : redactForStatus(item);
  }
  return out as T;
}
