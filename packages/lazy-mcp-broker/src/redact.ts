const SECRET_KEY_RE = /(authorization|token|secret|password|api[_-]?key|access[_-]?key|client[_-]?secret)/i;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;

export function redactText(value: string): string {
  return value.replace(BEARER_RE, 'Bearer [REDACTED]');
}

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactText(message);
}

export function redactObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactObject);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_RE.test(key) ? '[REDACTED]' : redactObject(item);
  }
  return out;
}
