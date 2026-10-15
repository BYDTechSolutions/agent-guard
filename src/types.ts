import type { JsonSchema } from './schema.js';
import type { RedactOptions } from './redact.js';

/** What the guard decided about one tool call. */
export type Decision = 'allow' | 'deny' | 'approve';

/**
 * One tool call the model asked for, in a provider-neutral shape. The adapters
 * build these from Anthropic, OpenAI and MCP payloads.
 */
export interface ToolCall {
  /** The provider's call id (`tool_use.id`, `tool_calls[].id`, `call_id`, JSON-RPC `id`). */
  id?: string;
  /** The tool name the model asked for. */
  name: string;
  /** The parsed arguments. */
  args: unknown;
  /**
   * Set by an adapter when the arguments could not be parsed (OpenAI sends them as a
   * JSON string, which the model does not always get right). Such a call is denied.
   */
  argsError?: string;
  /** Groups calls for rate limits and per-run counts. Defaults to `"default"`. */
  session?: string;
}

/**
 * A check on the arguments. Return a string to deny the call with that reason;
 * return nothing (or `null`, `undefined`, `true`) to pass.
 */
export type Constraint = (args: unknown, call: ToolCall) => string | null | undefined | void | true;

/**
 * A user validator. Return `true`, nothing or an empty array to pass; `false`, a
 * string or an array of strings to deny (the strings become the reason).
 */
export type Validator = (args: unknown, call: ToolCall) => boolean | string | string[] | null | undefined | void;

/** A sliding-window rate limit. */
export interface RateLimit {
  /** Most calls allowed inside the window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /**
   * `"session"` (default): each session has its own window for this tool.
   * `"tool"`: one window shared by every session.
   */
  per?: 'session' | 'tool';
}

/** The rule for one tool. Every field is optional; an empty rule allows the tool. */
export interface ToolRule {
  /**
   * What to do once every check passes: `"allow"` (default), `"deny"`, or `"approve"`
   * (run only after a human says yes). A function decides per call.
   */
  action?: Decision | ((args: unknown, call: ToolCall) => Decision);
  /** A JSON Schema (the subset described in the README) the arguments must match. */
  schema?: JsonSchema;
  /** Your own validator, run after `schema`. */
  validate?: Validator;
  /** Argument constraints such as {@link pathUnder}, {@link hostAllowed}, {@link sqlReadOnly}. */
  constraints?: Constraint[];
  /** A sliding-window rate limit for this tool. */
  rateLimit?: RateLimit;
  /** Most calls of this tool in one run (per session, until {@link Guard.reset}). */
  maxCalls?: number;
}

/** The whole policy passed to {@link defineGuard}. */
export interface GuardPolicy {
  /** A rule (or just a decision) per tool name. */
  tools: Record<string, ToolRule | Decision>;
  /** What happens to a tool that is not listed. Default `"deny"`. */
  default?: 'allow' | 'deny';
  /** Most calls of any tool in one run (per session, until {@link Guard.reset}). */
  maxCallsPerRun?: number;
  /** Called with every decision, arguments already redacted. */
  onDecision?: (record: AuditRecord) => void;
  /** Append every decision to this file as one JSON line. */
  auditFile?: string;
  /** How arguments and reasons are redacted before `onDecision` and `auditFile`. */
  redact?: RedactOptions | false;
  /** Milliseconds since the epoch. Defaults to `Date.now`; replace it in tests. */
  clock?: () => number;
}

/** The result of {@link Guard.check}. */
export interface GuardDecision {
  decision: Decision;
  /** A short sentence the model and the audit log can read. */
  reason: string;
  /**
   * Which part of the policy decided: `default`, `action`, `input`, `schema`,
   * `validate`, `constraint`, `rateLimit`, `maxCalls` or `maxCallsPerRun`.
   */
  rule: RuleName;
  /** The tool name. */
  tool: string;
}

export type RuleName =
  | 'default'
  | 'action'
  | 'input'
  | 'schema'
  | 'validate'
  | 'constraint'
  | 'rateLimit'
  | 'maxCalls'
  | 'maxCallsPerRun'
  | 'approval';

/** One line of the audit log. */
export interface AuditRecord {
  /** ISO 8601 time from the guard's clock. */
  time: string;
  /** `check` for the policy decision, `approval` for the human's answer to an `approve`. */
  event: 'check' | 'approval';
  tool: string;
  callId?: string;
  session: string;
  decision: Decision;
  rule: RuleName;
  reason: string;
  /** The arguments after redaction. */
  args: unknown;
}

/** Options for {@link Guard.check}. */
export interface CheckOptions {
  /**
   * Count the call against rate limits and run limits when it is not denied.
   * Default `true`. `false` makes a dry run that changes nothing.
   */
  record?: boolean;
  /** Emit the decision to `onDecision` and the audit file. Default `true`. */
  audit?: boolean;
}

/** Runs the tool. Receives the original, unredacted arguments. */
export type Executor<T> = (args: unknown, call: ToolCall) => T | Promise<T>;

/** Options for {@link Guard.run}. */
export interface RunOptions {
  /**
   * Asked when the decision is `approve`. Return (or resolve) `true` to run the tool.
   * Without it, an `approve` decision is treated as a denial. A throw counts as "no".
   */
  approve?: (call: ToolCall, decision: GuardDecision) => boolean | Promise<boolean>;
}

/** What {@link Guard.run} returns: enough to build the provider's tool-result message. */
export interface RunResult<T = unknown> {
  /** The call id, copied from the call. */
  id?: string;
  tool: string;
  /** Whether the executor ran. */
  ran: boolean;
  /** The final decision: `approve` resolves to `allow` or `deny` after the human answers. */
  decision: 'allow' | 'deny';
  reason: string;
  rule: RuleName;
  /** The executor's return value, when it ran. */
  output?: T;
  /**
   * Text for the model: the output (strings as they are, anything else as JSON),
   * or `"denied: <reason>"`.
   */
  content: string;
  /** `true` when the call was denied. */
  isError: boolean;
}

/** The minimum the adapters need to build a tool result. A {@link RunResult} fits. */
export interface ToolOutcome {
  /** The call id the result answers. */
  id?: string;
  /** Text for the model. */
  content: string;
  /** Marks the result as an error (a denial, or a failure you report yourself). */
  isError?: boolean;
}
