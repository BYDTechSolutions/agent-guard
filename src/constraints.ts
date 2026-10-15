/**
 * Small argument checks for the tool arguments that cause the most damage: file
 * paths, URLs and SQL. They are string checks made before a tool runs. They are not
 * a sandbox: they cannot see what the tool does with the value afterwards.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { Constraint } from './types.js';

/** Where a constraint finds its value: a property name, a dotted path, or a function. */
export type ArgPicker = string | ((args: unknown) => unknown);

interface PickOptions {
  /** Which argument to check. A string is a property name or a dotted path like `"target.url"`. */
  arg?: ArgPicker;
  /** Pass when the argument is absent (`undefined`). Default `false`: a missing argument is denied. */
  optional?: boolean;
}

function pick(args: unknown, picker: ArgPicker): unknown {
  if (typeof picker === 'function') return picker(args);
  let value: unknown = args;
  for (const key of picker.split('.')) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function argLabel(picker: ArgPicker): string {
  return typeof picker === 'string' ? picker : 'argument';
}

/**
 * Builds a constraint that applies `check` to the picked argument, or to every item
 * when it is an array.
 */
function makeConstraint(
  options: PickOptions,
  defaultArg: string,
  check: (value: unknown, label: string) => string | null,
): Constraint {
  const picker = options.arg ?? defaultArg;
  const label = argLabel(picker);
  return (args) => {
    const value = pick(args, picker);
    if (value === undefined) return options.optional ? null : `${label} is missing`;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      const problem = check(v, label);
      if (problem) return problem;
    }
    return null;
  };
}

// ---------------------------------------------------------------- paths

/** Options for {@link checkPath} and {@link pathUnder}. */
export interface PathOptions {
  /** Path rules to apply. Default: the platform this process runs on. */
  platform?: 'posix' | 'win32';
  /**
   * Allow `%2e`, `%2f`, `%5c` and `%00` in the path. Default `false`: a file system
   * does not decode them, but a tool that later URL-decodes the path would.
   */
  allowEncoded?: boolean;
  /**
   * Also resolve symbolic links (with `fs.realpathSync`) on the root and on the
   * deepest part of the path that exists, and check again. Default `false`: the check
   * is purely lexical. Only meaningful for paths on the machine running the guard.
   */
  resolveSymlinks?: boolean;
}

/** The outcome of {@link checkPath}. */
export type PathCheck = { ok: true; resolved: string } | { ok: false; reason: string };

function currentPlatform(): 'posix' | 'win32' {
  return process.platform === 'win32' ? 'win32' : 'posix';
}

function inside(p: path.PlatformPath, root: string, target: string): boolean {
  const rel = p.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
}

function realpathDeepest(p: path.PlatformPath, target: string): string {
  let existing = target;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(existing);
      return rest.length ? p.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = p.dirname(existing);
      if (parent === existing) return target;
      rest.push(p.basename(existing));
      existing = parent;
    }
  }
}

/**
 * Checks that `input` stays inside `root` after normalization. Relative paths are
 * resolved against `root` (not the working directory); absolute paths must already
 * be inside it. Rejects NUL bytes, `~`, percent-encoded dots and separators, and on
 * POSIX treats `\` as a separator and refuses Windows drive and UNC paths. On
 * Windows it refuses drive-relative paths (`C:foo`), device paths (`\\?\`, `\\.\`)
 * and any other `:` (alternate data streams), and compares case-insensitively.
 */
export function checkPath(root: string, input: unknown, options: PathOptions = {}): PathCheck {
  const platform = options.platform ?? currentPlatform();
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (typeof input !== 'string') return { ok: false, reason: 'path must be a string' };
  if (input.length === 0) return { ok: false, reason: 'path is empty' };
  if (input.includes('\0')) return { ok: false, reason: 'path contains a NUL byte' };
  if (!options.allowEncoded && /%(2e|2f|5c|00)/i.test(input)) {
    return { ok: false, reason: 'path contains a percent-encoded dot, separator or NUL' };
  }
  if (input.startsWith('~')) return { ok: false, reason: 'home-relative paths (~) are not allowed' };

  let candidate = input;
  if (platform === 'posix') {
    if (/^[a-zA-Z]:/.test(candidate) || candidate.startsWith('\\\\')) {
      return { ok: false, reason: 'Windows-style absolute paths are not allowed' };
    }
    candidate = candidate.replaceAll('\\', '/');
  } else {
    if (/^[\\/]{2}[?.][\\/]/.test(candidate)) return { ok: false, reason: 'Windows device paths are not allowed' };
    if (/^[a-zA-Z]:(?![\\/])/.test(candidate)) return { ok: false, reason: 'drive-relative paths (C:foo) are not allowed' };
    if (candidate.indexOf(':', /^[a-zA-Z]:/.test(candidate) ? 2 : 0) !== -1) {
      return { ok: false, reason: 'path contains ":"' };
    }
  }

  const resolvedRoot = p.resolve(root);
  const resolved = p.resolve(resolvedRoot, candidate);
  if (!inside(p, resolvedRoot, resolved)) {
    return { ok: false, reason: `path "${input}" resolves outside the allowed directory` };
  }
  if (options.resolveSymlinks) {
    const realRoot = realpathDeepest(p, resolvedRoot);
    const realTarget = realpathDeepest(p, resolved);
    if (!inside(p, realRoot, realTarget)) {
      return { ok: false, reason: `path "${input}" leaves the allowed directory through a symbolic link` };
    }
  }
  return { ok: true, resolved };
}

/** Whether `input` stays inside `root`. See {@link checkPath}. */
export function isPathInside(root: string, input: string, options: PathOptions = {}): boolean {
  return checkPath(root, input, options).ok;
}

/**
 * A constraint: the argument (default `path`; an array checks every item) must stay
 * inside `root`. See {@link checkPath} for the rules.
 *
 * ```ts
 * constraints: [pathUnder('/srv/workspace', { arg: 'file' })]
 * ```
 */
export function pathUnder(root: string, options: PathOptions & PickOptions = {}): Constraint {
  return makeConstraint(options, 'path', (value) => {
    const result = checkPath(root, value, options);
    return result.ok ? null : result.reason;
  });
}

// ---------------------------------------------------------------- hosts

/** Options for {@link checkUrlHost} and {@link hostAllowed}. */
export interface HostOptions {
  /** URL schemes allowed, without the colon. Default `["https"]`. */
  schemes?: string[];
  /** Allow `user:password@` in the URL. Default `false`. */
  allowUserinfo?: boolean;
}

interface HostEntry {
  wildcard: boolean;
  host: string;
  /** `''` = the scheme's default port only, `'*'` = any port. */
  port: string;
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

/**
 * Parses allowlist entries: `example.com` (exactly that host, default port),
 * `*.example.com` (any subdomain, not the apex), `example.com:8443` (that port),
 * `example.com:*` (any port). Unicode hosts are converted to punycode.
 */
function parseHostEntries(allowed: readonly string[]): HostEntry[] {
  return allowed.map((raw) => {
    const entry = raw.trim();
    const wildcard = entry.startsWith('*.');
    const rest = wildcard ? entry.slice(2) : entry;
    const anyPort = rest.endsWith(':*');
    let url: URL;
    try {
      url = new URL(`http://${anyPort ? rest.slice(0, -2) : rest}`);
    } catch {
      throw new TypeError(`hostAllowed: invalid host entry "${raw}"`);
    }
    if (!url.hostname || url.pathname !== '/' || url.username || url.search || url.hash) {
      throw new TypeError(`hostAllowed: invalid host entry "${raw}" (use a host, optionally with :port)`);
    }
    // new URL drops :80 for http; keep an explicit port as written.
    const explicitPort = /:(\d+)$/.exec(rest)?.[1] ?? '';
    return { wildcard, host: normalizeHost(url.hostname), port: anyPort ? '*' : explicitPort };
  });
}

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21' };

/** The outcome of {@link checkUrlHost}. */
export type HostCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Checks that `input` is an absolute URL whose host is on the allowlist. Hosts are
 * compared after WHATWG URL parsing, so `https://allowed.com@evil.com` is
 * `evil.com`, IDN hosts are compared in punycode, numeric IP forms are normalized,
 * and a trailing dot is ignored. A port other than the scheme's default must be on
 * the allowlist entry.
 */
export function checkUrlHost(allowed: readonly string[], input: unknown, options: HostOptions = {}): HostCheck {
  const entries = parseHostEntries(allowed);
  return checkWithEntries(entries, input, options);
}

function checkWithEntries(entries: HostEntry[], input: unknown, options: HostOptions): HostCheck {
  if (typeof input !== 'string') return { ok: false, reason: 'URL must be a string' };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'not a valid absolute URL' };
  }
  const schemes = (options.schemes ?? ['https']).map((s) => `${s.toLowerCase().replace(/:$/, '')}:`);
  if (!schemes.includes(url.protocol)) {
    return { ok: false, reason: `scheme "${url.protocol.slice(0, -1)}" is not allowed` };
  }
  if ((url.username || url.password) && !options.allowUserinfo) {
    return { ok: false, reason: 'URL contains credentials (user@host)' };
  }
  const host = normalizeHost(url.hostname);
  const port = url.port === DEFAULT_PORTS[url.protocol] ? '' : url.port;
  const ok = entries.some((e) => {
    const hostMatch = e.wildcard ? host.endsWith(`.${e.host}`) : host === e.host;
    const portMatch = e.port === '*' || e.port === port || (port === '' && e.port === DEFAULT_PORTS[url.protocol]);
    return hostMatch && portMatch;
  });
  if (!ok) return { ok: false, reason: `host "${host}${port ? `:${port}` : ''}" is not on the allowlist` };
  return { ok: true, url };
}

/**
 * A constraint: the argument (default `url`; an array checks every item) must be a
 * URL on one of the allowed hosts. See {@link checkUrlHost}.
 *
 * ```ts
 * constraints: [hostAllowed(['api.example.com', '*.example.org'])]
 * ```
 */
export function hostAllowed(allowed: readonly string[], options: HostOptions & PickOptions = {}): Constraint {
  const entries = parseHostEntries(allowed);
  return makeConstraint(options, 'url', (value) => {
    const result = checkWithEntries(entries, value, options);
    return result.ok ? null : result.reason;
  });
}

// ---------------------------------------------------------------- SQL

/** Words that write, lock, run code or change settings, denied anywhere in the statement. */
export const SQL_DENIED_WORDS: readonly string[] = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'RENAME',
  'INTO', 'COPY', 'CALL', 'EXEC', 'EXECUTE', 'DO', 'GRANT', 'REVOKE', 'LOCK', 'SET', 'RESET',
  'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'ANALYZE', 'LOAD', 'OUTFILE', 'DUMPFILE', 'BEGIN',
  'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'PREPARE', 'DEALLOCATE', 'LISTEN', 'NOTIFY',
];

/** Options for {@link checkReadOnlySql} and {@link sqlReadOnly}. */
export interface SqlOptions {
  /** More words to deny, such as functions with side effects (`PG_READ_FILE`). Case-insensitive. */
  denyWords?: string[];
}

/**
 * Checks that `sql` is a single `SELECT` (or `WITH ... SELECT`) statement. Returns
 * the reason it is not, or `null` when it passes.
 *
 * Dialects disagree on comments, escapes and quoting, and a disagreement is how a
 * write hides inside what looks like a string. So this refuses what it cannot read
 * the same way in every dialect: comments (`--`, `/*`), backslashes inside quotes,
 * dollar-quoted strings and unterminated quotes. Then it requires the first word to
 * be `SELECT` or `WITH`, allows one statement (a trailing `;` is fine), and denies
 * {@link SQL_DENIED_WORDS} anywhere outside quotes. It does not know which functions
 * have side effects; use a read-only database role as well.
 */
export function checkReadOnlySql(sql: unknown, options: SqlOptions = {}): string | null {
  if (typeof sql !== 'string') return 'SQL must be a string';
  let code = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') return 'SQL comments are not allowed';
    if (ch === '/' && next === '*') return 'SQL comments are not allowed';
    if (ch === '$' && /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.test(sql.slice(i)) && !/^\$\d/.test(sql.slice(i))) {
      return 'dollar-quoted strings are not allowed';
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        const c = sql[j]!;
        if (c === '\\' && ch !== '`') return 'backslashes inside quoted text are not allowed';
        if (c === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) return 'unterminated quoted text';
      code += ch === "'" ? " '' " : ' "" ';
      i = j + 1;
      continue;
    }
    code += ch;
    i++;
  }

  const semicolon = code.indexOf(';');
  if (semicolon !== -1 && code.slice(semicolon).replace(/[;\s]/g, '') !== '') {
    return 'only one SQL statement is allowed';
  }
  const words = (code.match(/[A-Za-z_][A-Za-z0-9_$]*/g) ?? []).map((w) => w.toUpperCase());
  const first = words[0];
  if (first !== 'SELECT' && first !== 'WITH') return 'only SELECT statements are allowed';
  const denied = new Set([...SQL_DENIED_WORDS, ...(options.denyWords ?? []).map((w) => w.toUpperCase())]);
  const hit = words.find((w) => denied.has(w));
  if (hit) return `SQL contains "${hit}", which is not allowed in a read-only query`;
  return null;
}

/**
 * A constraint: the argument (default `sql`) must be one read-only `SELECT`. See
 * {@link checkReadOnlySql}.
 *
 * ```ts
 * constraints: [sqlReadOnly({ arg: 'query' })]
 * ```
 */
export function sqlReadOnly(options: SqlOptions & PickOptions = {}): Constraint {
  return makeConstraint(options, 'sql', (value) => checkReadOnlySql(value, options));
}
