import { appendFileSync } from 'node:fs';
import { compileSchema, formatSchemaErrors, type SchemaValidator } from './schema.js';
import { SlidingWindow } from './rate.js';
import { redact, redactString } from './redact.js';
import type {
  AuditRecord,
  CheckOptions,
  Decision,
  Executor,
  GuardDecision,
  GuardPolicy,
  RuleName,
  RunOptions,
  RunResult,
  ToolCall,
  ToolRule,
} from './types.js';

/** Thrown by {@link defineGuard} when the policy itself is wrong. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

/** A policy ready to check calls. Create one with {@link defineGuard}. */
export interface Guard {
  /**
   * Decides whether a call may run. Does not run it. Unless `record: false`, a call
   * that is not denied counts against rate limits and run limits.
   */
  check(call: ToolCall, options?: CheckOptions): GuardDecision;
  /**
   * Checks the call, asks for approval when needed, and runs `executor` only when
   * allowed or approved. A denial comes back as a result the model can read
   * (`"denied: <reason>"`), so the agent loop can carry on. Errors thrown by the
   * executor are not caught.
   */
  run<T>(call: ToolCall, executor: Executor<T>, options?: RunOptions): Promise<RunResult<T>>;
  /** Starts a new run: clears the per-run call counts for one session, or for all. Rate-limit windows are kept. */
  reset(session?: string): void;
  /** The policy as given. */
  readonly policy: Readonly<GuardPolicy>;
}

interface CompiledRule {
  action: NonNullable<ToolRule['action']>;
  schema?: SchemaValidator;
  validate?: ToolRule['validate'];
  constraints: NonNullable<ToolRule['constraints']>;
  rateLimit?: ToolRule['rateLimit'];
  maxCalls?: number;
}

const RULE_KEYS = new Set(['action', 'schema', 'validate', 'constraints', 'rateLimit', 'maxCalls']);
const POLICY_KEYS = new Set(['tools', 'default', 'maxCallsPerRun', 'onDecision', 'auditFile', 'redact', 'clock']);
const DECISIONS = new Set<Decision>(['allow', 'deny', 'approve']);
const DEFAULT_SESSION = 'default';

function positiveInt(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new PolicyError(`${where} must be a non-negative integer`);
  }
  return value;
}

function compileRule(name: string, raw: ToolRule | Decision): CompiledRule {
  if (typeof raw === 'string') {
    if (!DECISIONS.has(raw)) throw new PolicyError(`tools.${name}: "${raw}" is not allow, deny or approve`);
    return { action: raw, constraints: [] };
  }
  if (typeof raw !== 'object' || raw === null) throw new PolicyError(`tools.${name}: a rule must be an object or a decision`);
  const unknown = Object.keys(raw).filter((k) => !RULE_KEYS.has(k));
  if (unknown.length) throw new PolicyError(`tools.${name}: unknown rule field ${unknown.map((k) => `"${k}"`).join(', ')}`);
  const action = raw.action ?? 'allow';
  if (typeof action !== 'function' && !DECISIONS.has(action)) {
    throw new PolicyError(`tools.${name}.action: "${String(action)}" is not allow, deny or approve`);
  }
  if (raw.validate !== undefined && typeof raw.validate !== 'function') throw new PolicyError(`tools.${name}.validate must be a function`);
  if (raw.constraints !== undefined && (!Array.isArray(raw.constraints) || raw.constraints.some((c) => typeof c !== 'function'))) {
    throw new PolicyError(`tools.${name}.constraints must be an array of functions`);
  }
  if (raw.rateLimit !== undefined) {
    const { max, windowMs, per } = raw.rateLimit;
    positiveInt(max, `tools.${name}.rateLimit.max`);
    if (typeof windowMs !== 'number' || !(windowMs > 0)) throw new PolicyError(`tools.${name}.rateLimit.windowMs must be a positive number`);
    if (per !== undefined && per !== 'session' && per !== 'tool') throw new PolicyError(`tools.${name}.rateLimit.per must be "session" or "tool"`);
  }
  let schema: SchemaValidator | undefined;
  if (raw.schema !== undefined) {
    try {
      schema = compileSchema(raw.schema, `tools.${name}.schema`);
    } catch (err) {
      throw new PolicyError((err as Error).message);
    }
  }
  return {
    action,
    schema,
    validate: raw.validate,
    constraints: raw.constraints ?? [],
    rateLimit: raw.rateLimit,
    maxCalls: raw.maxCalls === undefined ? undefined : positiveInt(raw.maxCalls, `tools.${name}.maxCalls`),
  };
}

function formatWindow(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

function toContent(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined) return '';
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}

/**
 * Builds a guard from a policy. Throws {@link PolicyError} for a policy it cannot
 * enforce (an unknown rule field, an unsupported schema keyword, a bad limit), so
 * mistakes surface at startup rather than as a silently allowed call.
 *
 * ```ts
 * const guard = defineGuard({
 *   default: 'deny',
 *   tools: {
 *     read_file: { schema: { type: 'object', required: ['path'] }, constraints: [pathUnder('/srv/work')] },
 *     delete_file: { action: 'approve' },
 *   },
 * });
 * ```
 */
export function defineGuard(policy: GuardPolicy): Guard {
  if (typeof policy !== 'object' || policy === null) throw new PolicyError('policy must be an object');
  const unknown = Object.keys(policy).filter((k) => !POLICY_KEYS.has(k));
  if (unknown.length) throw new PolicyError(`unknown policy field ${unknown.map((k) => `"${k}"`).join(', ')}`);
  if (typeof policy.tools !== 'object' || policy.tools === null) throw new PolicyError('policy.tools must be an object');
  const fallback = policy.default ?? 'deny';
  if (fallback !== 'allow' && fallback !== 'deny') throw new PolicyError('policy.default must be "allow" or "deny"');
  const maxCallsPerRun = policy.maxCallsPerRun === undefined ? undefined : positiveInt(policy.maxCallsPerRun, 'policy.maxCallsPerRun');

  const rules = new Map<string, CompiledRule>();
  for (const [name, rule] of Object.entries(policy.tools)) rules.set(name, compileRule(name, rule));

  const clock = policy.clock ?? Date.now;
  const windows = new SlidingWindow(clock);
  const runCounts = new Map<string, Map<string, number>>(); // session -> tool ('*' = all) -> count
  const redactOptions = policy.redact === false ? undefined : (policy.redact ?? {});

  const countOf = (session: string, tool: string) => runCounts.get(session)?.get(tool) ?? 0;
  const bump = (session: string, tool: string) => {
    let m = runCounts.get(session);
    if (!m) runCounts.set(session, (m = new Map()));
    m.set(tool, (m.get(tool) ?? 0) + 1);
  };

  const emit = (call: ToolCall, event: AuditRecord['event'], d: { decision: Decision; rule: RuleName; reason: string }) => {
    if (!policy.onDecision && !policy.auditFile) return;
    const record: AuditRecord = {
      time: new Date(clock()).toISOString(),
      event,
      tool: call.name,
      ...(call.id !== undefined ? { callId: call.id } : {}),
      session: call.session ?? DEFAULT_SESSION,
      decision: d.decision,
      rule: d.rule,
      reason: redactOptions ? redactString(d.reason, redactOptions) : d.reason,
      args: redactOptions ? redact(call.args, redactOptions) : call.args,
    };
    if (policy.auditFile) appendFileSync(policy.auditFile, `${JSON.stringify(record)}\n`);
    policy.onDecision?.(record);
  };

  const decide = (call: ToolCall, record: boolean): GuardDecision => {
    const tool = typeof call?.name === 'string' ? call.name : '';
    const deny = (rule: RuleName, reason: string): GuardDecision => ({ decision: 'deny', reason, rule, tool });
    if (!tool) return deny('input', 'the call has no tool name');
    if (call.argsError) return deny('input', `arguments could not be parsed: ${call.argsError}`);

    const rule = Object.hasOwn(policy.tools, tool) ? rules.get(tool) : undefined;
    if (!rule) {
      return fallback === 'allow'
        ? { decision: 'allow', reason: `${tool} is not in the policy; allowed by default`, rule: 'default', tool }
        : deny('default', `${tool} is not an allowed tool`);
    }
    if (rule.action === 'deny') return deny('action', `${tool} is not allowed by policy`);

    const args = call.args;
    if (rule.schema) {
      const errors = rule.schema(args).map((e) => ({ path: `args${e.path}`, message: e.message }));
      if (errors.length) return deny('schema', `invalid arguments: ${formatSchemaErrors(errors)}`);
    }
    // A user function that throws fails closed: the call is denied.
    const attempt = <R>(fn: () => R, rule: RuleName): R | GuardDecision => {
      try {
        return fn();
      } catch (err) {
        return deny(rule, `the ${rule} check failed: ${(err as Error)?.message ?? String(err)}`);
      }
    };
    const isDecision = (v: unknown): v is GuardDecision =>
      typeof v === 'object' && v !== null && 'decision' in v && 'rule' in v && 'tool' in v;

    if (rule.validate) {
      const validate = rule.validate;
      const verdict = attempt(() => validate(args, call), 'validate');
      if (isDecision(verdict)) return verdict;
      if (verdict === false) return deny('validate', 'invalid arguments');
      if (typeof verdict === 'string' && verdict) return deny('validate', `invalid arguments: ${verdict}`);
      if (Array.isArray(verdict) && verdict.length) return deny('validate', `invalid arguments: ${verdict.join('; ')}`);
    }
    for (const constraint of rule.constraints) {
      const problem = attempt(() => constraint(args, call), 'constraint');
      if (isDecision(problem)) return problem;
      if (typeof problem === 'string' && problem) return deny('constraint', problem);
    }

    const ruleAction = rule.action;
    const action = typeof ruleAction === 'function' ? attempt(() => ruleAction(args, call), 'action') : ruleAction;
    if (isDecision(action)) return action;
    if (!DECISIONS.has(action)) return deny('action', `the policy for ${tool} returned an invalid decision`);
    if (action === 'deny') return deny('action', `${tool} is not allowed by policy for these arguments`);

    const session = call.session ?? DEFAULT_SESSION;
    if (maxCallsPerRun !== undefined && countOf(session, '*') >= maxCallsPerRun) {
      return deny('maxCallsPerRun', `this run reached its limit of ${maxCallsPerRun} tool calls`);
    }
    if (rule.maxCalls !== undefined && countOf(session, tool) >= rule.maxCalls) {
      return deny('maxCalls', `${tool} reached its limit of ${rule.maxCalls} calls in this run`);
    }
    const rl = rule.rateLimit;
    const rateKey = rl ? (rl.per === 'tool' ? `tool\0${tool}` : `session\0${session}\0${tool}`) : '';
    if (rl) {
      const wait = windows.retryAfter(rateKey, rl.max, rl.windowMs);
      if (wait > 0) {
        return deny('rateLimit', `${tool} is limited to ${rl.max} calls per ${formatWindow(rl.windowMs)}; retry in ${Math.ceil(wait / 1000)}s`);
      }
    }

    if (record) {
      bump(session, '*');
      bump(session, tool);
      if (rl) windows.hit(rateKey);
    }
    return action === 'approve'
      ? { decision: 'approve', reason: `${tool} needs approval`, rule: 'action', tool }
      : { decision: 'allow', reason: `${tool} is allowed`, rule: 'action', tool };
  };

  const check = (call: ToolCall, options: CheckOptions = {}): GuardDecision => {
    const result = decide(call, options.record ?? true);
    if (options.audit ?? true) emit(call, 'check', result);
    return result;
  };

  const run = async <T>(call: ToolCall, executor: Executor<T>, options: RunOptions = {}): Promise<RunResult<T>> => {
    const d = check(call);
    const denied = (rule: RunResult['rule'], reason: string): RunResult<T> => ({
      ...(call.id !== undefined ? { id: call.id } : {}),
      tool: d.tool,
      ran: false,
      decision: 'deny',
      reason,
      rule,
      content: `denied: ${reason}`,
      isError: true,
    });
    if (d.decision === 'deny') return denied(d.rule, d.reason);

    let reason = d.reason;
    let rule: RuleName = d.rule;
    if (d.decision === 'approve') {
      let approved = false;
      let why = 'approval was declined';
      if (!options.approve) {
        why = `${d.tool} needs approval and no approver is configured`;
      } else {
        try {
          approved = (await options.approve(call, d)) === true;
        } catch (err) {
          why = `approval failed: ${(err as Error)?.message ?? String(err)}`;
        }
      }
      emit(call, 'approval', approved
        ? { decision: 'allow', rule: 'approval', reason: 'approved' }
        : { decision: 'deny', rule: 'approval', reason: why });
      if (!approved) return denied('approval', why);
      reason = 'approved';
      rule = 'approval';
    }

    const output = await executor(call.args, call);
    return {
      ...(call.id !== undefined ? { id: call.id } : {}),
      tool: d.tool,
      ran: true,
      decision: 'allow',
      reason,
      rule,
      output,
      content: toContent(output),
      isError: false,
    };
  };

  return {
    check,
    run,
    reset(session?: string) {
      if (session === undefined) runCounts.clear();
      else runCounts.delete(session);
    },
    policy,
  };
}
