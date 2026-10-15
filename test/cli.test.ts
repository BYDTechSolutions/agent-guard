import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT, main, type CliIo } from '../src/commands.js';
import { defineGuard, VERSION, type AuditRecord } from '../src/index.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-guard-cli-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function io(stdin = '') {
  let out = '';
  let err = '';
  const value: CliIo = {
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    readStdin: async () => stdin,
    cwd: dir,
  };
  return { io: value, out: () => out, err: () => err };
}

const POLICY = `export default {
  default: 'deny',
  tools: {
    read_file: {
      schema: { type: 'object', required: ['path'] },
      validate: (args) => (String(args.path).includes('..') ? 'no parent paths' : true),
    },
    send_email: 'approve',
  },
};
`;

describe('general', () => {
  it('prints help with no command and with --help', async () => {
    const a = io();
    expect(await main([], a.io)).toBe(EXIT.OK);
    expect(a.out()).toMatch(/Usage:/);
    const b = io();
    expect(await main(['check', '--help'], b.io)).toBe(EXIT.OK);
    expect(b.out()).toMatch(/agent-guard audit/);
  });

  it('prints the version, which matches package.json', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    const a = io();
    expect(await main(['--version'], a.io)).toBe(EXIT.OK);
    expect(a.out().trim()).toBe(pkg.version);
    expect(VERSION).toBe(pkg.version);
  });

  it('rejects unknown commands and options with exit 2', async () => {
    const a = io();
    expect(await main(['frobnicate'], a.io)).toBe(EXIT.USAGE);
    expect(a.err()).toMatch(/unknown command "frobnicate"/);
    const b = io();
    expect(await main(['check', '--polcy', 'x'], b.io)).toBe(EXIT.USAGE);
    expect(b.err()).toMatch(/--polcy/);
  });
});

describe('check', () => {
  beforeEach(async () => {
    await writeFile(join(dir, 'policy.mjs'), POLICY);
  });

  it('exits 0 for allow, 1 for deny, 3 for approve', async () => {
    const allow = io();
    expect(await main(['check', '--policy', 'policy.mjs', '--call', '{"name":"read_file","args":{"path":"a.md"}}'], allow.io)).toBe(EXIT.OK);
    expect(allow.out()).toBe('allow: read_file is allowed (rule: action)\n');

    const deny = io();
    expect(await main(['check', '--policy', 'policy.mjs', '--call', '{"name":"read_file","args":{"path":"../a"}}'], deny.io)).toBe(EXIT.DENIED);
    expect(deny.out()).toBe('deny: invalid arguments: no parent paths (rule: validate)\n');

    const approve = io();
    expect(await main(['check', '--policy', 'policy.mjs', '--call', '{"name":"send_email","args":{}}'], approve.io)).toBe(EXIT.APPROVE);

    const unknown = io();
    expect(await main(['check', '--policy', 'policy.mjs', '--call', '{"name":"rm"}'], unknown.io)).toBe(EXIT.DENIED);
    expect(unknown.out()).toMatch(/rm is not an allowed tool/);
  });

  it('accepts arguments as a JSON string, input, stdin, and prints JSON', async () => {
    const a = io();
    expect(await main(['check', '--policy', 'policy.mjs', '--call', '{"name":"read_file","arguments":"{\\"path\\":\\"x\\"}"}'], a.io)).toBe(EXIT.OK);
    const b = io('{"name":"read_file","input":{"path":"x"}}');
    expect(await main(['check', '--policy', join(dir, 'policy.mjs'), '--call', '-', '--json'], b.io)).toBe(EXIT.OK);
    expect(JSON.parse(b.out())).toEqual({ decision: 'allow', reason: 'read_file is allowed', rule: 'action', tool: 'read_file' });
    const c = io();
    expect(await main(['check', '--policy', 'policy.mjs', '--call', '{"name":"read_file","arguments":"{bad"}'], c.io)).toBe(EXIT.DENIED);
    expect(c.out()).toMatch(/could not be parsed/);
  });

  it('loads a module that exports a guard, and the example policy', async () => {
    await writeFile(join(dir, 'guard.mjs'), `export default { check: () => ({ decision: 'deny', reason: 'custom', rule: 'action', tool: 'x' }) };\n`);
    const a = io();
    expect(await main(['check', '--policy', 'guard.mjs', '--call', '{"name":"x"}'], a.io)).toBe(EXIT.DENIED);
    expect(a.out()).toMatch(/custom/);

    const example = new URL('../examples/policy.mjs', import.meta.url).pathname;
    const b = io();
    expect(await main(['check', '--policy', example, '--call', '{"name":"read_file","args":{"path":"../.env"}}'], b.io)).toBe(EXIT.DENIED);
    expect(b.out()).toMatch(/outside the allowed directory/);
    const c = io();
    expect(await main(['check', '--policy', example, '--call', '{"name":"run_sql","args":{"sql":"SELECT 1"}}'], c.io)).toBe(EXIT.OK);
  });

  it('reports usage errors with exit 2', async () => {
    const cases: [string[], RegExp][] = [
      [['check', '--call', '{}'], /needs --policy/],
      [['check', '--policy', 'policy.mjs'], /needs --call/],
      [['check', '--policy', 'policy.mjs', '--call', 'nope'], /not valid JSON/],
      [['check', '--policy', 'policy.mjs', '--call', '[1]'], /JSON object/],
      [['check', '--policy', 'policy.mjs', '--call', '{"args":{}}'], /needs a "name"/],
      [['check', '--policy', 'missing.mjs', '--call', '{"name":"a"}'], /could not load the policy/],
      [['check', 'extra', '--policy', 'policy.mjs', '--call', '{"name":"a"}'], /no positional/],
    ];
    for (const [argv, pattern] of cases) {
      const a = io();
      expect(await main(argv, a.io), argv.join(' ')).toBe(EXIT.USAGE);
      expect(a.err()).toMatch(pattern);
    }
  });

  it('reports an invalid policy or export', async () => {
    await writeFile(join(dir, 'bad.mjs'), `export default { tools: { a: { rateLimt: {} } } };\n`);
    await writeFile(join(dir, 'empty.mjs'), `export const x = 1;\n`);
    const a = io();
    expect(await main(['check', '--policy', 'bad.mjs', '--call', '{"name":"a"}'], a.io)).toBe(EXIT.USAGE);
    expect(a.err()).toMatch(/invalid: .*rateLimt/);
    const b = io();
    expect(await main(['check', '--policy', 'empty.mjs', '--call', '{"name":"a"}'], b.io)).toBe(EXIT.USAGE);
    expect(b.err()).toMatch(/must export a policy/);
  });
});

describe('audit', () => {
  async function writeLog(): Promise<string> {
    const file = join(dir, 'audit.jsonl');
    let now = Date.UTC(2026, 9, 16, 9, 0, 0);
    const guard = defineGuard({
      auditFile: file,
      clock: () => (now += 1000),
      tools: { read_file: { validate: (a) => ((a as { path: string }).path.includes('..') ? 'no parent paths' : true) }, send_email: 'approve' },
    });
    guard.check({ name: 'read_file', args: { path: 'a' } });
    guard.check({ name: 'read_file', args: { path: '../a' } });
    guard.check({ name: 'read_file', args: { path: '../b' } });
    guard.check({ name: 'rm', args: {} });
    await guard.run({ name: 'send_email', args: { to: 'x', password: 'p' } }, () => 'sent', { approve: () => true });
    await guard.run({ name: 'send_email', args: {} }, () => 'sent', { approve: () => false });
    return file;
  }

  it('summarizes counts, approvals and denial reasons', async () => {
    const file = await writeLog();
    await writeFile(file, `${await readFile(file, 'utf8')}not json\n{"also":"not a record"}\n`);
    const a = io();
    expect(await main(['audit', 'audit.jsonl'], a.io)).toBe(EXIT.OK);
    const text = a.out();
    expect(text).toContain('6 decisions: 1 allowed, 3 denied, 2 sent for approval');
    expect(text).toContain('from 2026-10-16T09:00:01.000Z to 2026-10-16T09:00:08.000Z');
    expect(text).toContain('approvals: 1 approved, 1 declined');
    expect(text).toMatch(/read_file\s+1\s+2\s+0\s+3/);
    expect(text).toMatch(/rm\s+0\s+1\s+0\s+1/);
    expect(text).toMatch(/send_email\s+0\s+0\s+2\s+2/);
    expect(text).toContain('   2  read_file [validate] invalid arguments: no parent paths');
    expect(text).toContain('   1  rm [default] rm is not an allowed tool');
    expect(text).toContain('   1  send_email [approval] approval was declined');
    expect(text).toContain('skipped 2 lines that are not audit records: 9, 10');
  });

  it('prints JSON with --json and reads stdin with -', async () => {
    const file = await writeLog();
    const a = io(await readFile(file, 'utf8'));
    expect(await main(['audit', '-', '--json'], a.io)).toBe(EXIT.OK);
    const summary = JSON.parse(a.out()) as { checks: number; byDecision: Record<string, number>; denials: { count: number }[] };
    expect(summary.checks).toBe(6);
    expect(summary.byDecision).toEqual({ allow: 1, deny: 3, approve: 2 });
    expect(summary.denials[0]!.count).toBe(2);
  });

  it('never writes secrets to the log', async () => {
    const file = await writeLog();
    const records = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as AuditRecord);
    expect(JSON.stringify(records)).not.toContain('"p"');
    expect(records.find((r) => r.tool === 'send_email')!.args).toEqual({ to: 'x', password: '[REDACTED]' });
  });

  it('reports a missing file or argument with exit 2', async () => {
    const a = io();
    expect(await main(['audit'], a.io)).toBe(EXIT.USAGE);
    const b = io();
    expect(await main(['audit', 'nope.jsonl'], b.io)).toBe(EXIT.USAGE);
    expect(b.err()).toMatch(/could not read nope.jsonl/);
    const c = io();
    expect(await main(['audit', 'a', 'b'], c.io)).toBe(EXIT.USAGE);
  });

  it('handles an empty log', async () => {
    await writeFile(join(dir, 'empty.jsonl'), '');
    const a = io();
    expect(await main(['audit', 'empty.jsonl'], a.io)).toBe(EXIT.OK);
    expect(a.out()).toBe('0 decisions: 0 allowed, 0 denied, 0 sent for approval\n');
  });
});
