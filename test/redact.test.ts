import { describe, expect, it } from 'vitest';
import { redact, redactString } from '../src/index.js';

describe('redact', () => {
  it('replaces values under secret keys, ignoring case, dashes and underscores', () => {
    expect(
      redact({
        password: 'p',
        API_KEY: 'k',
        'x-api-key': 'k2',
        Authorization: 'Basic abc',
        client_secret: 's',
        nested: { refreshToken: 'r', ok: 'visible' },
        list: [{ cookie: 'c' }],
      }),
    ).toEqual({
      password: '[REDACTED]',
      API_KEY: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      Authorization: '[REDACTED]',
      client_secret: '[REDACTED]',
      nested: { refreshToken: '[REDACTED]', ok: 'visible' },
      list: [{ cookie: '[REDACTED]' }],
    });
  });

  it('matches long names as suffixes, short names only exactly', () => {
    expect(redact({ db_password: 'p', githubToken: 't', max_tokens: 5, spin: 1, pin: '1234', author: 'a' })).toEqual({
      db_password: '[REDACTED]',
      githubToken: '[REDACTED]',
      max_tokens: 5,
      spin: 1,
      pin: '[REDACTED]',
      author: 'a',
    });
  });

  it('leaves empty secret values alone, so a log shows they were empty', () => {
    expect(redact({ password: '', token: null })).toEqual({ password: '', token: null });
  });

  it('finds secrets inside strings', () => {
    const cases: [string, string][] = [
      ['Authorization: Bearer abc.def-ghi_jkl', 'Authorization: [REDACTED]'],
      ['key sk-ant-api03-abcdefghijklmnopqrstuv here', 'key [REDACTED] here'],
      ['key sk-proj-abcdefghijklmnopqrstuv', 'key [REDACTED]'],
      ['AKIAIOSFODNN7EXAMPLE', '[REDACTED]'],
      ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', '[REDACTED]'],
      ['xoxb-1234567890-abcdefghij', '[REDACTED]'],
      ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'jwt [REDACTED]'],
      ['postgres://app:s3cr3t@db.internal:5432/main', 'postgres://app:[REDACTED]@db.internal:5432/main'],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', '[REDACTED]'],
    ];
    for (const [input, expected] of cases) expect(redactString(input), input).toBe(expected);
  });

  it('does not touch ordinary text', () => {
    expect(redactString('read notes/todo.md and https://example.com/a?b=c')).toBe('read notes/todo.md and https://example.com/a?b=c');
  });

  it('takes extra keys, key patterns, string patterns and a replacement', () => {
    expect(
      redact({ ssn: '123-45-6789', internal_id: 'x', note: 'card 4111 1111 1111 1111' }, {
        keys: ['ssn', /^internal_/],
        patterns: [/\b(?:\d{4} ){3}\d{4}\b/g],
        replacement: '***',
      }),
    ).toEqual({ ssn: '***', internal_id: '***', note: 'card ***' });
  });

  it('handles cycles, dates, bigints and functions without throwing', () => {
    const a: Record<string, unknown> = { name: 'a', when: new Date(Date.UTC(2026, 0, 1)), big: 10n, fn: () => 1 };
    a.self = a;
    expect(redact(a)).toEqual({ name: 'a', when: '2026-01-01T00:00:00.000Z', big: '10n', fn: '[function]', self: '[Circular]' });
  });

  it('keeps shared references that are not cycles', () => {
    const shared = { v: 1 };
    expect(redact({ a: shared, b: shared })).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });

  it('cuts very long strings', () => {
    const out = redactString('x'.repeat(30), { maxStringLength: 10 });
    expect(out).toBe('xxxxxxxxxx... [20 more characters]');
  });

  it('does not change the input', () => {
    const input = { password: 'p', inner: { token: 't' } };
    redact(input);
    expect(input).toEqual({ password: 'p', inner: { token: 't' } });
  });
});
