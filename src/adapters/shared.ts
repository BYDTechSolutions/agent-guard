/** Parses a JSON-encoded arguments string the way the OpenAI APIs send it. */
export function parseArguments(raw: unknown): { args: unknown; argsError?: string } {
  if (raw === undefined || raw === null || raw === '') return { args: {} };
  if (typeof raw !== 'string') return { args: raw };
  try {
    return { args: JSON.parse(raw) as unknown };
  } catch (err) {
    return { args: raw, argsError: (err as Error).message };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireId(id: string | undefined, where: string): string {
  if (typeof id !== 'string' || !id) throw new TypeError(`${where}: the result has no call id`);
  return id;
}
