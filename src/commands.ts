import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { formatAuditSummary, parseAuditLog, summarizeAudit } from './audit.js';
import { defineGuard, type Guard } from './guard.js';
import type { GuardPolicy, ToolCall } from './types.js';
import { VERSION } from './version.js';

/** Exit codes. `check` maps its decision onto them: allow 0, deny 1, approve 3. */
export const EXIT = { OK: 0, DENIED: 1, USAGE: 2, APPROVE: 3 } as const;

/** Everything the CLI touches outside itself, so tests can replace it. */
export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
  cwd: string;
}

export const HELP = `agent-guard ${VERSION}: check LLM tool calls against a policy

Usage:
  agent-guard check --policy <file.mjs> --call '<json>' [--json]
  agent-guard audit <file.jsonl> [--json]

Commands:
  check   Dry-run one tool call against a policy and print the decision.
          The policy module's default export is a policy object or a guard.
          The call is {"name": "...", "args": {...}}; "arguments" (an object or a
          JSON string) and "input" are read as args too. --call - reads stdin.
  audit   Summarize an audit log written with the auditFile option: counts by
          tool and decision, approvals, and every denial reason.

Options:
  --policy <file>   Policy module (.mjs or .js) for check
  --call <json>     The tool call for check, or - for stdin
  --session <id>    Session id for the call (default: "default")
  --json            Print JSON instead of text
  -h, --help        Show this help
  -v, --version     Show the version

Exit codes: 0 allowed (or audit printed), 1 denied, 2 usage or input error,
3 needs approval.
`;

class UsageError extends Error {}

function parseCall(text: string, session: string | undefined): ToolCall {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`--call is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new UsageError('--call must be a JSON object');
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || !r.name) throw new UsageError('--call needs a "name"');
  const call: ToolCall = { name: r.name, args: {} };
  if (typeof r.id === 'string') call.id = r.id;
  const args = r.args ?? r.input ?? r.arguments;
  if (typeof args === 'string') {
    try {
      call.args = JSON.parse(args);
    } catch (err) {
      call.args = args;
      call.argsError = (err as Error).message;
    }
  } else if (args !== undefined) {
    call.args = args;
  }
  const s = session ?? (typeof r.session === 'string' ? r.session : undefined);
  if (s !== undefined) call.session = s;
  return call;
}

async function loadGuard(file: string, cwd: string): Promise<Guard> {
  const full = isAbsolute(file) ? file : resolve(cwd, file);
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(full).href)) as Record<string, unknown>;
  } catch (err) {
    throw new UsageError(`could not load the policy ${file}: ${(err as Error).message}`);
  }
  const exported = mod.default ?? mod.guard ?? mod.policy;
  if (typeof exported === 'object' && exported !== null && typeof (exported as Guard).check === 'function') {
    return exported as Guard;
  }
  if (typeof exported === 'object' && exported !== null && 'tools' in exported) {
    try {
      return defineGuard(exported as GuardPolicy);
    } catch (err) {
      throw new UsageError(`the policy in ${file} is invalid: ${(err as Error).message}`);
    }
  }
  throw new UsageError(`${file} must export a policy object or a guard as its default export`);
}

async function runCheck(values: Record<string, unknown>, io: CliIo): Promise<number> {
  if (typeof values.policy !== 'string') throw new UsageError('check needs --policy <file.mjs>');
  if (typeof values.call !== 'string') throw new UsageError("check needs --call '<json>'");
  const callText = values.call === '-' ? await io.readStdin() : values.call;
  const call = parseCall(callText, values.session as string | undefined);
  const guard = await loadGuard(values.policy, io.cwd);
  const d = guard.check(call, { record: false, audit: false });
  if (values.json) {
    io.stdout(`${JSON.stringify(d, null, 2)}\n`);
  } else {
    io.stdout(`${d.decision}: ${d.reason} (rule: ${d.rule})\n`);
  }
  return d.decision === 'allow' ? EXIT.OK : d.decision === 'approve' ? EXIT.APPROVE : EXIT.DENIED;
}

async function runAudit(positionals: string[], values: Record<string, unknown>, io: CliIo): Promise<number> {
  const file = positionals[0];
  if (!file) throw new UsageError('audit needs a file: agent-guard audit <file.jsonl>');
  if (positionals.length > 1) throw new UsageError('audit takes one file');
  let text: string;
  try {
    text = file === '-' ? await io.readStdin() : await readFile(isAbsolute(file) ? file : resolve(io.cwd, file), 'utf8');
  } catch (err) {
    throw new UsageError(`could not read ${file}: ${(err as Error).message}`);
  }
  const { records, invalidLines } = parseAuditLog(text);
  const summary = summarizeAudit(records, invalidLines);
  io.stdout(values.json ? `${JSON.stringify(summary, null, 2)}\n` : formatAuditSummary(summary));
  return EXIT.OK;
}

/** Runs the CLI with `argv` (without `node` and the script) and returns the exit code. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        policy: { type: 'string' },
        call: { type: 'string' },
        session: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
    if (values.version) {
      io.stdout(`${VERSION}\n`);
      return EXIT.OK;
    }
    const [command, ...rest] = positionals;
    if (values.help || !command) {
      io.stdout(HELP);
      return EXIT.OK;
    }
    if (command === 'check') {
      if (rest.length) throw new UsageError(`check takes no positional arguments (got "${rest[0]}")`);
      return await runCheck(values, io);
    }
    if (command === 'audit') return await runAudit(rest, values, io);
    throw new UsageError(`unknown command "${command}"`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`agent-guard: ${message}\nRun agent-guard --help for usage.\n`);
    return EXIT.USAGE;
  }
}
