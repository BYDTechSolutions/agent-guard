import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkPath,
  checkReadOnlySql,
  checkUrlHost,
  hostAllowed,
  isPathInside,
  pathUnder,
  sqlReadOnly,
} from '../src/index.js';

const call = { name: 't', args: {} };

describe('checkPath on POSIX', () => {
  const root = '/srv/work';
  const ok = (p: string) => checkPath(root, p, { platform: 'posix' });

  it('allows relative paths inside the root, resolved against the root', () => {
    expect(ok('notes/todo.md')).toEqual({ ok: true, resolved: '/srv/work/notes/todo.md' });
    expect(ok('./a/../b')).toEqual({ ok: true, resolved: '/srv/work/b' });
    expect(ok('.')).toEqual({ ok: true, resolved: '/srv/work' });
    expect(ok('..file')).toMatchObject({ ok: true });
  });

  it('allows absolute paths that are already inside', () => {
    expect(ok('/srv/work/a.txt')).toMatchObject({ ok: true });
  });

  it('denies parent traversal', () => {
    for (const p of ['../secret', '../../etc/passwd', 'a/../../b', 'a/b/../../../c', '..']) {
      expect(ok(p), p).toMatchObject({ ok: false, reason: expect.stringMatching(/outside/) });
    }
  });

  it('denies absolute paths outside the root', () => {
    expect(ok('/etc/passwd')).toMatchObject({ ok: false });
    expect(ok('//etc/passwd')).toMatchObject({ ok: false });
  });

  it('denies sibling directories that share a prefix', () => {
    expect(ok('/srv/work-evil/x')).toMatchObject({ ok: false });
    expect(ok('../work-evil/x')).toMatchObject({ ok: false });
    expect(ok('/srv/workx')).toMatchObject({ ok: false });
  });

  it('denies percent-encoded traversal unless allowed', () => {
    for (const p of ['%2e%2e/%2e%2e/etc/passwd', '..%2fsecret', '%2E%2E%5Csecret', 'a%00.txt']) {
      expect(ok(p), p).toMatchObject({ ok: false, reason: expect.stringMatching(/percent-encoded/) });
    }
    expect(checkPath(root, '%2e%2e', { platform: 'posix', allowEncoded: true })).toMatchObject({ ok: true });
  });

  it('treats backslashes as separators and refuses Windows absolute paths', () => {
    expect(ok('..\\..\\etc\\passwd')).toMatchObject({ ok: false, reason: expect.stringMatching(/outside/) });
    expect(ok('a\\b.txt')).toEqual({ ok: true, resolved: '/srv/work/a/b.txt' });
    expect(ok('C:\\Windows\\system32')).toMatchObject({ ok: false, reason: expect.stringMatching(/Windows-style/) });
    expect(ok('c:/x')).toMatchObject({ ok: false });
    expect(ok('\\\\server\\share\\x')).toMatchObject({ ok: false });
  });

  it('denies NUL bytes, home paths, empty strings and non-strings', () => {
    expect(ok('a\0.txt')).toMatchObject({ ok: false, reason: expect.stringMatching(/NUL/) });
    expect(ok('~/.ssh/id_rsa')).toMatchObject({ ok: false, reason: expect.stringMatching(/home/) });
    expect(ok('')).toMatchObject({ ok: false });
    expect(checkPath(root, 42, { platform: 'posix' })).toMatchObject({ ok: false, reason: 'path must be a string' });
  });
});

describe('checkPath on Windows', () => {
  const root = 'C:\\work';
  const ok = (p: string) => checkPath(root, p, { platform: 'win32' });

  it('allows paths inside, compared case-insensitively', () => {
    expect(ok('notes\\todo.md')).toMatchObject({ ok: true, resolved: 'C:\\work\\notes\\todo.md' });
    expect(ok('notes/todo.md')).toMatchObject({ ok: true });
    expect(ok('c:\\WORK\\a.txt')).toMatchObject({ ok: true });
  });

  it('denies traversal with either separator', () => {
    expect(ok('..\\secret')).toMatchObject({ ok: false });
    expect(ok('../secret')).toMatchObject({ ok: false });
    expect(ok('a\\..\\..\\b')).toMatchObject({ ok: false });
  });

  it('denies other drives, UNC, device and drive-relative paths, and streams', () => {
    expect(ok('D:\\work\\a')).toMatchObject({ ok: false });
    expect(ok('\\\\server\\share\\a')).toMatchObject({ ok: false });
    expect(ok('\\\\?\\C:\\work\\a')).toMatchObject({ ok: false, reason: expect.stringMatching(/device/) });
    expect(ok('\\\\.\\PhysicalDrive0')).toMatchObject({ ok: false, reason: expect.stringMatching(/device/) });
    expect(ok('C:secret')).toMatchObject({ ok: false, reason: expect.stringMatching(/drive-relative/) });
    expect(ok('a.txt:hidden')).toMatchObject({ ok: false, reason: 'path contains ":"' });
  });

  it('denies a root-relative path, which lands on the root of the drive', () => {
    expect(ok('\\Windows\\win.ini')).toMatchObject({ ok: false });
  });
});

describe('checkPath with resolveSymlinks', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-guard-'));
    await mkdir(join(dir, 'root', 'sub'), { recursive: true });
    await mkdir(join(dir, 'outside'));
    await writeFile(join(dir, 'outside', 'secret.txt'), 'x');
    await symlink(join(dir, 'outside'), join(dir, 'root', 'escape'));
    await symlink(join(dir, 'root', 'sub'), join(dir, 'root', 'inner'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is lexical by default, and follows links when asked', () => {
    const root = join(dir, 'root');
    expect(checkPath(root, 'escape/secret.txt')).toMatchObject({ ok: true });
    expect(checkPath(root, 'escape/secret.txt', { resolveSymlinks: true })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/symbolic link/),
    });
    expect(checkPath(root, 'escape/new-file.txt', { resolveSymlinks: true })).toMatchObject({ ok: false });
    expect(checkPath(root, 'inner/new.txt', { resolveSymlinks: true })).toMatchObject({ ok: true });
    expect(checkPath(root, 'missing/deeper/file.txt', { resolveSymlinks: true })).toMatchObject({ ok: true });
  });
});

describe('pathUnder', () => {
  it('reads the path argument by default and checks arrays item by item', () => {
    const c = pathUnder('/srv/work', { platform: 'posix' });
    expect(c({ path: 'a.txt' }, call)).toBeNull();
    expect(c({ path: '../x' }, call)).toMatch(/outside/);
    const many = pathUnder('/srv/work', { platform: 'posix', arg: 'files' });
    expect(many({ files: ['a', 'b'] }, call)).toBeNull();
    expect(many({ files: ['a', '/etc/passwd'] }, call)).toMatch(/outside/);
  });

  it('denies a missing argument unless optional, and supports dotted paths and functions', () => {
    expect(pathUnder('/srv', { platform: 'posix' })({}, call)).toBe('path is missing');
    expect(pathUnder('/srv', { platform: 'posix', optional: true })({}, call)).toBeNull();
    expect(pathUnder('/srv', { platform: 'posix', arg: 'target.file' })({ target: { file: '../x' } }, call)).toMatch(/outside/);
    expect(pathUnder('/srv', { platform: 'posix', arg: (a) => (a as { p: string }).p })({ p: 'ok' }, call)).toBeNull();
  });

  it('isPathInside is the boolean form', () => {
    expect(isPathInside('/srv', 'a', { platform: 'posix' })).toBe(true);
    expect(isPathInside('/srv', '../a', { platform: 'posix' })).toBe(false);
  });
});

describe('checkUrlHost', () => {
  const allow = ['api.example.com', '*.example.org', 'localhost:3000', 'bücher.example', 'ports.example.com:*'];
  const host = (url: unknown, opts = {}) => checkUrlHost(allow, url, opts);

  it('allows listed hosts on the default port', () => {
    expect(host('https://api.example.com/v1/status')).toMatchObject({ ok: true });
    expect(host('https://API.Example.COM/')).toMatchObject({ ok: true });
    expect(host('https://api.example.com:443/')).toMatchObject({ ok: true });
    expect(host('https://api.example.com./')).toMatchObject({ ok: true });
  });

  it('matches wildcard subdomains but not the apex or lookalikes', () => {
    expect(host('https://a.b.example.org/')).toMatchObject({ ok: true });
    expect(host('https://example.org/')).toMatchObject({ ok: false });
    expect(host('https://evilexample.org/')).toMatchObject({ ok: false });
    expect(host('https://api.example.com.evil.net/')).toMatchObject({ ok: false });
  });

  it('reads the real host behind userinfo tricks, and refuses credentials', () => {
    expect(host('https://api.example.com@evil.example.net/')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/credentials/),
    });
    expect(host('https://api.example.com@evil.example.net/', { allowUserinfo: true })).toMatchObject({
      ok: false,
      reason: 'host "evil.example.net" is not on the allowlist',
    });
    expect(host('https://user:pw@api.example.com/', { allowUserinfo: true })).toMatchObject({ ok: true });
    expect(host('https://evil.example.net\\@api.example.com/')).toMatchObject({ ok: false });
  });

  it('compares IDN hosts in punycode, so lookalikes do not match', () => {
    expect(host('https://bücher.example/')).toMatchObject({ ok: true });
    expect(host('https://xn--bcher-kva.example/')).toMatchObject({ ok: true });
    // Cyrillic "а" in place of the Latin "a"
    expect(host('https://\u0430pi.example.com/')).toMatchObject({ ok: false, reason: expect.stringMatching(/xn--/) });
  });

  it('requires a listed port for non-default ports', () => {
    expect(host('https://api.example.com:8443/')).toMatchObject({ ok: false, reason: expect.stringMatching(/:8443/) });
    expect(host('http://localhost:3000/', { schemes: ['http'] })).toMatchObject({ ok: true });
    expect(host('http://localhost/', { schemes: ['http'] })).toMatchObject({ ok: false });
    expect(host('http://localhost:3001/', { schemes: ['http'] })).toMatchObject({ ok: false });
    expect(host('https://ports.example.com:9999/')).toMatchObject({ ok: true });
  });

  it('refuses other schemes, relative and invalid URLs', () => {
    expect(host('http://api.example.com/')).toMatchObject({ ok: false, reason: 'scheme "http" is not allowed' });
    expect(host('file:///etc/passwd')).toMatchObject({ ok: false });
    expect(host('javascript:alert(1)')).toMatchObject({ ok: false });
    expect(host('/v1/status')).toMatchObject({ ok: false, reason: 'not a valid absolute URL' });
    expect(host(42)).toMatchObject({ ok: false, reason: 'URL must be a string' });
  });

  it('normalizes numeric IP forms before comparing', () => {
    expect(checkUrlHost(['127.0.0.1'], 'https://2130706433/')).toMatchObject({ ok: true });
    expect(checkUrlHost(['example.com'], 'https://0x7f000001/')).toMatchObject({ ok: false, reason: expect.stringMatching(/127\.0\.0\.1/) });
    expect(checkUrlHost(['[::1]:8080'], 'https://[::1]:8080/')).toMatchObject({ ok: true });
  });

  it('refuses invalid allowlist entries at definition time', () => {
    expect(() => hostAllowed(['https://example.com/path'])).toThrow(TypeError);
    expect(() => hostAllowed(['exa mple.com'])).toThrow(TypeError);
  });

  it('hostAllowed reads the url argument', () => {
    const c = hostAllowed(['api.example.com']);
    expect(c({ url: 'https://api.example.com/x' }, call)).toBeNull();
    expect(c({ url: 'https://evil.net/' }, call)).toMatch(/allowlist/);
    expect(c({}, call)).toBe('url is missing');
  });
});

describe('checkReadOnlySql', () => {
  it('allows single SELECT and WITH queries', () => {
    expect(checkReadOnlySql('SELECT id, email FROM users WHERE id = 1')).toBeNull();
    expect(checkReadOnlySql('select * from t;')).toBeNull();
    expect(checkReadOnlySql('  WITH recent AS (SELECT * FROM orders) SELECT count(*) FROM recent ;  ')).toBeNull();
    expect(checkReadOnlySql("SELECT 'drop table users; --' AS s")).toBeNull();
    expect(checkReadOnlySql('SELECT "update", `delete` FROM t')).toBeNull();
    expect(checkReadOnlySql("SELECT 'it''s'")).toBeNull();
    expect(checkReadOnlySql('SELECT updated_at, insert_count FROM t WHERE id = $1')).toBeNull();
  });

  it('denies other statements', () => {
    for (const q of ['DELETE FROM users', 'UPDATE t SET a = 1', 'DROP TABLE t', 'INSERT INTO t VALUES (1)', 'EXPLAIN ANALYZE SELECT 1', 'SHOW TABLES']) {
      expect(checkReadOnlySql(q), q).toBe('only SELECT statements are allowed');
    }
  });

  it('denies stacked statements', () => {
    expect(checkReadOnlySql('SELECT 1; DROP TABLE users')).toBe('only one SQL statement is allowed');
    expect(checkReadOnlySql('SELECT 1;;SELECT 2')).toBe('only one SQL statement is allowed');
  });

  it('denies writes hidden inside a SELECT', () => {
    expect(checkReadOnlySql('WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d')).toMatch(/"DELETE"/);
    expect(checkReadOnlySql('SELECT * INTO backup FROM users')).toMatch(/"INTO"/);
    expect(checkReadOnlySql('SELECT * FROM users FOR UPDATE')).toMatch(/"UPDATE"/);
    expect(checkReadOnlySql("SELECT * FROM t INTO OUTFILE '/tmp/x'")).toMatch(/"INTO"/);
  });

  it('refuses what dialects read differently', () => {
    expect(checkReadOnlySql('SELECT 1 -- ; DROP TABLE t')).toBe('SQL comments are not allowed');
    expect(checkReadOnlySql('SELECT /* x */ 1')).toBe('SQL comments are not allowed');
    expect(checkReadOnlySql('SELECT /*!50000 DROP TABLE t */ 1')).toBe('SQL comments are not allowed');
    expect(checkReadOnlySql("SELECT 'a\\'' ; DROP TABLE t; -- '")).toBe('backslashes inside quoted text are not allowed');
    expect(checkReadOnlySql('SELECT $$; DROP TABLE t; $$')).toBe('dollar-quoted strings are not allowed');
    expect(checkReadOnlySql('SELECT $tag$x$tag$')).toBe('dollar-quoted strings are not allowed');
    expect(checkReadOnlySql("SELECT 'open")).toBe('unterminated quoted text');
  });

  it('takes extra denied words, case-insensitively', () => {
    expect(checkReadOnlySql("SELECT pg_read_file('/etc/passwd')", { denyWords: ['pg_read_file'] })).toMatch(/PG_READ_FILE/);
  });

  it('sqlReadOnly reads the sql argument', () => {
    expect(sqlReadOnly()({ sql: 'SELECT 1' }, call)).toBeNull();
    expect(sqlReadOnly({ arg: 'query' })({ query: 'DELETE FROM t' }, call)).toMatch(/only SELECT/);
    expect(sqlReadOnly()({ sql: 5 }, call)).toBe('SQL must be a string');
  });
});
