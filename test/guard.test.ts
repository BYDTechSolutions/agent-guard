import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defineGuard, pathUnder, PolicyError, type AuditRecord, type GuardPolicy, type ToolCall } from '../src/index.js';

const call = (name: string, args: unknown = {}, extra: Partial<ToolCall> = {}): ToolCall => ({ name, args, ...extra });

/** A clock the test moves by hand. */
function manualClock(start = Date.UTC(2026, 9, 16, 12, 0, 0)) {
  let now = start;
  return { clock: () => now, advance: (ms: number) => (now += ms) };
}

describe('default and per-tool decisions', () => {
  it('denies unlisted tools by default', () => {
    const guard = defineGuard({ tools: {} });
    expect(guard.check(call('rm'))).toEqual({ decision: 'deny', reason: 'rm is not an allowed tool', rule: 'default', tool: 'rm' });
  });

  it('allows unlisted tools with default: allow', () => {
    const guard = defineGuard({ tools: {}, default: 'allow' });
    expect(guard.check(call('anything'))).toMatchObject({ decision: 'allow', rule: 'default' });
  });

  it('applies the shorthand decisions', () => {
    const guard = defineGuard({ tools: { read: 'allow', rm: 'deny', send: 'approve' }, default: 'allow' });
    expect(guard.check(call('read')).decision).toBe('allow');
    expect(guard.check(call('rm'))).toMatchObject({ decision: 'deny', rule: 'action' });
    expect(guard.check(call('send'))).toMatchObject({ decision: 'approve', rule: 'action' });
  });

  it('treats an empty rule as allow', () => {
    expect(defineGuard({ tools: { read: {} } }).check(call('read')).decision).toBe('allow');
  });

  it('does not match tool names against Object.prototype', () => {
    const guard = defineGuard({ tools: {} });
    expect(guard.check(call('constructor')).decision).toBe('deny');
    expect(guard.check(call('__proto__')).decision).toBe('deny');
  });

  it('lets an action function decide per call', () => {
    const guard = defineGuard({
      tools: {
        transfer: { action: (args) => ((args as { amount: number }).amount > 100 ? 'approve' : 'allow') },
        odd: { action: () => 'maybe' as never },
      },
    });
    expect(guard.check(call('transfer', { amount: 5 })).decision).toBe('allow');
    expect(guard.check(call('transfer', { amount: 500 })).decision).toBe('approve');
    expect(guard.check(call('odd'))).toMatchObject({ decision: 'deny', rule: 'action' });
  });

  it('denies calls without a name and calls whose arguments did not parse', () => {
    const guard = defineGuard({ tools: { a: 'allow' } });
    expect(guard.check({ name: '', args: {} })).toMatchObject({ decision: 'deny', rule: 'input' });
    expect(guard.check({ name: 'a', args: '{bad', argsError: 'Unexpected token' })).toMatchObject({
      decision: 'deny',
      rule: 'input',
      reason: 'arguments could not be parsed: Unexpected token',
    });
  });
});

describe('argument checks', () => {
  const guard = defineGuard({
    tools: {
      read_file: {
        schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
        constraints: [pathUnder('/srv/work', { platform: 'posix' })],
      },
      search: {
        validate: (args) => ((args as { q?: string }).q?.trim() ? true : 'q must not be blank'),
      },
      tags: { validate: () => ['too many tags', 'tag too long'] },
      flag: { validate: () => false },
    },
  });

  it('denies on schema errors before anything else', () => {
    expect(guard.check(call('read_file', { path: 7 }))).toMatchObject({
      decision: 'deny',
      rule: 'schema',
      reason: 'invalid arguments: args.path expected string, got integer',
    });
    expect(guard.check(call('read_file', 'notes.md'))).toMatchObject({ rule: 'schema' });
  });

  it('denies on constraint failures', () => {
    expect(guard.check(call('read_file', { path: '../../etc/passwd' }))).toMatchObject({ decision: 'deny', rule: 'constraint' });
    expect(guard.check(call('read_file', { path: 'notes.md' })).decision).toBe('allow');
  });

  it('turns validator results into reasons', () => {
    expect(guard.check(call('search', { q: ' ' }))).toMatchObject({ rule: 'validate', reason: 'invalid arguments: q must not be blank' });
    expect(guard.check(call('search', { q: 'x' })).decision).toBe('allow');
    expect(guard.check(call('tags')).reason).toBe('invalid arguments: too many tags; tag too long');
    expect(guard.check(call('flag')).reason).toBe('invalid arguments');
  });

  it('fails closed when a user function throws', () => {
    const g = defineGuard({
      tools: {
        v: { validate: () => { throw new Error('boom'); } },
        c: { constraints: [() => { throw new Error('bad'); }] },
        a: { action: () => { throw new Error('nope'); } },
      },
    });
    expect(g.check(call('v'))).toMatchObject({ decision: 'deny', rule: 'validate', reason: 'the validate check failed: boom' });
    expect(g.check(call('c'))).toMatchObject({ decision: 'deny', rule: 'constraint' });
    expect(g.check(call('a'))).toMatchObject({ decision: 'deny', rule: 'action' });
  });
});

describe('rate limits', () => {
  it('uses a sliding window per tool and session', () => {
    const t = manualClock();
    const guard = defineGuard({ clock: t.clock, tools: { search: { rateLimit: { max: 2, windowMs: 60_000 } } } });
    expect(guard.check(call('search')).decision).toBe('allow');
    t.advance(10_000);
    expect(guard.check(call('search')).decision).toBe('allow');
    const third = guard.check(call('search'));
    expect(third).toMatchObject({ decision: 'deny', rule: 'rateLimit' });
    expect(third.reason).toBe('search is limited to 2 calls per 1m; retry in 50s');
    // Another session has its own window.
    expect(guard.check(call('search', {}, { session: 'b' })).decision).toBe('allow');
    // The first call leaves the window 60s after it was made.
    t.advance(49_999);
    expect(guard.check(call('search')).decision).toBe('deny');
    t.advance(1);
    expect(guard.check(call('search')).decision).toBe('allow');
    expect(guard.check(call('search')).decision).toBe('deny');
  });

  it('shares one window across sessions with per: tool', () => {
    const t = manualClock();
    const guard = defineGuard({ clock: t.clock, tools: { send: { rateLimit: { max: 1, windowMs: 1000, per: 'tool' } } } });
    expect(guard.check(call('send', {}, { session: 'a' })).decision).toBe('allow');
    expect(guard.check(call('send', {}, { session: 'b' })).decision).toBe('deny');
    t.advance(1000);
    expect(guard.check(call('send', {}, { session: 'b' })).decision).toBe('allow');
  });

  it('does not count denied calls or dry runs', () => {
    const t = manualClock();
    const guard = defineGuard({
      clock: t.clock,
      tools: { s: { schema: { type: 'object', required: ['q'] }, rateLimit: { max: 1, windowMs: 1000 } } },
    });
    expect(guard.check(call('s', {})).decision).toBe('deny');
    expect(guard.check(call('s', { q: 1 }), { record: false }).decision).toBe('allow');
    expect(guard.check(call('s', { q: 1 })).decision).toBe('allow');
    expect(guard.check(call('s', { q: 1 })).decision).toBe('deny');
  });
});

describe('call limits per run', () => {
  it('caps calls per tool and per run, per session, until reset', () => {
    const guard = defineGuard({ maxCallsPerRun: 3, tools: { a: { maxCalls: 2 }, b: 'allow' } });
    expect(guard.check(call('a')).decision).toBe('allow');
    expect(guard.check(call('a')).decision).toBe('allow');
    expect(guard.check(call('a'))).toMatchObject({ decision: 'deny', rule: 'maxCalls', reason: 'a reached its limit of 2 calls in this run' });
    expect(guard.check(call('b')).decision).toBe('allow');
    expect(guard.check(call('b'))).toMatchObject({ decision: 'deny', rule: 'maxCallsPerRun' });
    expect(guard.check(call('b', {}, { session: 'other' })).decision).toBe('allow');
    guard.reset('default');
    expect(guard.check(call('a')).decision).toBe('allow');
    expect(guard.check(call('b', {}, { session: 'other' })).decision).toBe('allow');
    guard.reset();
    expect(guard.check(call('a')).decision).toBe('allow');
    expect(guard.check(call('a')).decision).toBe('allow');
  });

  it('counts calls sent for approval', () => {
    const guard = defineGuard({ tools: { send: { action: 'approve', maxCalls: 1 } } });
    expect(guard.check(call('send')).decision).toBe('approve');
    expect(guard.check(call('send')).decision).toBe('deny');
  });
});

describe('run', () => {
  it('runs allowed calls with the original arguments and returns readable content', async () => {
    const guard = defineGuard({ tools: { add: 'allow', echo: 'allow', nothing: 'allow' } });
    const executor = vi.fn((args: unknown) => ({ sum: (args as { a: number; b: number }).a + (args as { a: number; b: number }).b }));
    const result = await guard.run(call('add', { a: 1, b: 2 }, { id: 'toolu_1' }), executor);
    expect(executor).toHaveBeenCalledWith({ a: 1, b: 2 }, expect.objectContaining({ name: 'add' }));
    expect(result).toEqual({
      id: 'toolu_1',
      tool: 'add',
      ran: true,
      decision: 'allow',
      reason: 'add is allowed',
      rule: 'action',
      output: { sum: 3 },
      content: '{"sum":3}',
      isError: false,
    });
    expect((await guard.run(call('echo'), async () => 'plain text')).content).toBe('plain text');
    expect((await guard.run(call('nothing'), () => undefined)).content).toBe('');
  });

  it('returns a denial the model can read instead of throwing', async () => {
    const guard = defineGuard({ tools: {} });
    const executor = vi.fn();
    const result = await guard.run(call('rm', { path: '/' }, { id: 'call_9' }), executor);
    expect(executor).not.toHaveBeenCalled();
    expect(result).toEqual({
      id: 'call_9',
      tool: 'rm',
      ran: false,
      decision: 'deny',
      reason: 'rm is not an allowed tool',
      rule: 'default',
      content: 'denied: rm is not an allowed tool',
      isError: true,
    });
  });

  it('runs an approve call only when the approver says yes', async () => {
    const guard = defineGuard({ tools: { send_email: 'approve' } });
    const executor = vi.fn(() => 'sent');
    const yes = await guard.run(call('send_email'), executor, { approve: () => true });
    expect(yes).toMatchObject({ ran: true, decision: 'allow', rule: 'approval', reason: 'approved', content: 'sent' });
    const asyncYes = await guard.run(call('send_email'), executor, { approve: async () => true });
    expect(asyncYes.ran).toBe(true);
    const no = await guard.run(call('send_email'), executor, { approve: async () => false });
    expect(no).toMatchObject({ ran: false, decision: 'deny', rule: 'approval', content: 'denied: approval was declined' });
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it('treats a missing approver, a throwing approver and a truthy non-boolean as no', async () => {
    const guard = defineGuard({ tools: { pay: 'approve' } });
    const executor = vi.fn();
    expect((await guard.run(call('pay'), executor)).reason).toBe('pay needs approval and no approver is configured');
    expect((await guard.run(call('pay'), executor, { approve: () => { throw new Error('timeout'); } })).reason).toBe(
      'approval failed: timeout',
    );
    expect((await guard.run(call('pay'), executor, { approve: () => 'yes' as unknown as boolean })).ran).toBe(false);
    expect(executor).not.toHaveBeenCalled();
  });

  it('passes the call and decision to the approver', async () => {
    const guard = defineGuard({ tools: { pay: 'approve' } });
    const approve = vi.fn(() => true);
    await guard.run(call('pay', { amount: 3 }), () => 'ok', { approve });
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'pay', args: { amount: 3 } }),
      expect.objectContaining({ decision: 'approve', rule: 'action' }),
    );
  });

  it('lets executor errors propagate', async () => {
    const guard = defineGuard({ tools: { x: 'allow' } });
    await expect(guard.run(call('x'), () => { throw new Error('disk full'); })).rejects.toThrow('disk full');
  });
});

describe('audit', () => {
  it('emits every decision with redacted arguments', async () => {
    const t = manualClock();
    const records: AuditRecord[] = [];
    const guard = defineGuard({
      clock: t.clock,
      onDecision: (r) => records.push(r),
      tools: { login: 'allow', pay: 'approve' },
    });
    guard.check(call('login', { user: 'sam', password: 'hunter2', note: 'Bearer abcdefghijklmnop' }, { id: 'c1' }));
    await guard.run(call('pay', { amount: 3 }, { session: 's1' }), () => 'ok', { approve: () => false });
    guard.check(call('nope'), { audit: false });
    expect(records).toEqual([
      {
        time: '2026-10-16T12:00:00.000Z',
        event: 'check',
        tool: 'login',
        callId: 'c1',
        session: 'default',
        decision: 'allow',
        rule: 'action',
        reason: 'login is allowed',
        args: { user: 'sam', password: '[REDACTED]', note: '[REDACTED]' },
      },
      expect.objectContaining({ event: 'check', tool: 'pay', session: 's1', decision: 'approve' }),
      expect.objectContaining({ event: 'approval', tool: 'pay', decision: 'deny', rule: 'approval', reason: 'approval was declined' }),
    ]);
  });

  it('does not redact the arguments the executor receives', async () => {
    const guard = defineGuard({ onDecision: () => {}, tools: { login: 'allow' } });
    const seen: unknown[] = [];
    await guard.run(call('login', { password: 'hunter2' }), (args) => seen.push(args));
    expect(seen).toEqual([{ password: 'hunter2' }]);
  });

  it('can turn redaction off or extend it', () => {
    const records: AuditRecord[] = [];
    defineGuard({ redact: false, onDecision: (r) => records.push(r), tools: { a: 'allow' } }).check(call('a', { password: 'x' }));
    defineGuard({ redact: { keys: ['ssn'] }, onDecision: (r) => records.push(r), tools: { a: 'allow' } }).check(call('a', { ssn: '123' }));
    expect(records.map((r) => r.args)).toEqual([{ password: 'x' }, { ssn: '[REDACTED]' }]);
  });

  it('appends JSON lines to the audit file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-guard-'));
    try {
      const file = join(dir, 'audit.jsonl');
      const guard = defineGuard({ auditFile: file, tools: { a: 'allow' } });
      guard.check(call('a', { token: 'secret-value' }));
      guard.check(call('b'));
      const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as AuditRecord);
      expect(lines.map((l) => [l.tool, l.decision])).toEqual([['a', 'allow'], ['b', 'deny']]);
      expect(lines[0]!.args).toEqual({ token: '[REDACTED]' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('policy errors', () => {
  const bad = (policy: unknown) => () => defineGuard(policy as GuardPolicy);

  it('refuses mistakes at definition time', () => {
    expect(bad(null)).toThrow(PolicyError);
    expect(bad({})).toThrow(/policy.tools/);
    expect(bad({ tools: {}, defualt: 'allow' })).toThrow(/unknown policy field "defualt"/);
    expect(bad({ tools: {}, default: 'approve' })).toThrow(/policy.default/);
    expect(bad({ tools: { a: 'yes' } })).toThrow(/not allow, deny or approve/);
    expect(bad({ tools: { a: { rateLimt: {} } } })).toThrow(/unknown rule field "rateLimt"/);
    expect(bad({ tools: { a: { action: 'maybe' } } })).toThrow(/tools.a.action/);
    expect(bad({ tools: { a: { schema: { oneOf: [] } } } })).toThrow(/unsupported keyword "oneOf"/);
    expect(bad({ tools: { a: { rateLimit: { max: 1, windowMs: 0 } } } })).toThrow(/windowMs/);
    expect(bad({ tools: { a: { rateLimit: { max: -1, windowMs: 10 } } } })).toThrow(/max/);
    expect(bad({ tools: { a: { rateLimit: { max: 1, windowMs: 10, per: 'user' } } } })).toThrow(/per/);
    expect(bad({ tools: { a: { maxCalls: 1.5 } } })).toThrow(/maxCalls/);
    expect(bad({ tools: {}, maxCallsPerRun: -2 })).toThrow(/maxCallsPerRun/);
    expect(bad({ tools: { a: { validate: 'x' } } })).toThrow(/validate/);
    expect(bad({ tools: { a: { constraints: ['x'] } } })).toThrow(/constraints/);
  });
});
