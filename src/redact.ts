/**
 * Redaction of secrets in tool arguments before they are logged. The executor always
 * receives the original arguments; only the audit copy is redacted.
 */

/** Options for {@link redact}. */
export interface RedactOptions {
  /**
   * More property names whose values are replaced whole. Strings match
   * case-insensitively, ignoring `-` and `_`, and names of five or more characters
   * also match as a suffix; regular expressions are tested as is.
   */
  keys?: (string | RegExp)[];
  /** More patterns replaced inside any string value. Use the `g` flag. */
  patterns?: RegExp[];
  /** What replaces a secret. Default `"[REDACTED]"`. */
  replacement?: string;
  /** Longest string kept, in characters; longer ones are cut with a note. Default 2000. */
  maxStringLength?: number;
}

/**
 * Property names whose values are always replaced, compared without case, `-` or `_`.
 * Names of five or more characters also match as a suffix (`x-api-key`, `db_password`).
 */
export const DEFAULT_SECRET_KEYS: readonly string[] = [
  'password', 'passwd', 'pwd', 'secret', 'clientsecret', 'token', 'accesstoken', 'refreshtoken',
  'idtoken', 'apikey', 'apisecret', 'authorization', 'auth', 'cookie', 'setcookie', 'privatekey',
  'accesskey', 'secretkey', 'sessionid', 'credentials', 'credential', 'passphrase', 'otp', 'pin',
];

/** Patterns replaced inside strings: well-known key formats, bearer tokens, JWTs, PEM keys, URL passwords. */
export const DEFAULT_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g,
  /(?<=[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:)[^/\s@]+(?=@)/gi,
];

const REPLACEMENT = '[REDACTED]';

function squash(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/** Replaces secrets inside one string. */
export function redactString(value: string, options: RedactOptions = {}): string {
  const replacement = options.replacement ?? REPLACEMENT;
  let out = value;
  for (const pattern of [...DEFAULT_SECRET_PATTERNS, ...(options.patterns ?? [])]) {
    out = out.replace(pattern, replacement);
  }
  const max = options.maxStringLength ?? 2000;
  if (out.length > max) out = `${out.slice(0, max)}... [${out.length - max} more characters]`;
  return out;
}

/**
 * Returns a redacted deep copy of `value`: values under secret-looking keys are
 * replaced whole, secret-looking substrings are replaced inside every string, and
 * cycles become `"[Circular]"`. Functions, symbols and bigints become strings.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const replacement = options.replacement ?? REPLACEMENT;
  const keySet = new Set(DEFAULT_SECRET_KEYS);
  const keyPatterns: RegExp[] = [];
  for (const k of options.keys ?? []) {
    if (typeof k === 'string') keySet.add(squash(k));
    else keyPatterns.push(k);
  }
  // Long names also match as a suffix (`x-api-key`, `db_password`); short ones only exactly.
  const suffixes = [...keySet].filter((k) => k.length >= 5);
  const isSecretKey = (key: string) => {
    const k = squash(key);
    return (
      keySet.has(k) ||
      suffixes.some((s) => k.endsWith(s)) ||
      keyPatterns.some((p) => {
        p.lastIndex = 0;
        return p.test(key);
      })
    );
  };
  const seen = new WeakSet<object>();

  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactString(v, options);
    if (v === null || typeof v === 'number' || typeof v === 'boolean' || v === undefined) return v;
    if (typeof v === 'bigint') return `${v.toString()}n`;
    if (typeof v === 'function' || typeof v === 'symbol') return `[${typeof v}]`;
    const obj = v as object;
    if (seen.has(obj)) return '[Circular]';
    seen.add(obj);
    let out: unknown;
    if (Array.isArray(obj)) {
      out = obj.map(walk);
    } else if (obj instanceof Date) {
      out = obj.toISOString();
    } else {
      const copy: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(obj)) {
        copy[key] = isSecretKey(key) && child !== null && child !== undefined && child !== '' ? replacement : walk(child);
      }
      out = copy;
    }
    seen.delete(obj);
    return out;
  };
  return walk(value);
}
