/**
 * @bydtech/agent-guard: a policy layer between an LLM agent and its tools. Every
 * tool call the model asks for is checked (allowed, denied, or sent to a human)
 * before it runs.
 *
 * @packageDocumentation
 */
export { defineGuard, PolicyError, type Guard } from './guard.js';
export {
  compileSchema,
  validateSchema,
  formatSchemaErrors,
  SchemaDefinitionError,
  type JsonSchema,
  type JsonType,
  type SchemaError,
  type SchemaValidator,
} from './schema.js';
export {
  pathUnder,
  checkPath,
  isPathInside,
  hostAllowed,
  checkUrlHost,
  sqlReadOnly,
  checkReadOnlySql,
  SQL_DENIED_WORDS,
  type ArgPicker,
  type PathOptions,
  type PathCheck,
  type HostOptions,
  type HostCheck,
  type SqlOptions,
} from './constraints.js';
export { redact, redactString, DEFAULT_SECRET_KEYS, DEFAULT_SECRET_PATTERNS, type RedactOptions } from './redact.js';
export { SlidingWindow } from './rate.js';
export {
  fromAnthropic,
  toAnthropicResult,
  toAnthropicMessage,
  type AnthropicToolUseBlock,
  type AnthropicToolResultBlock,
} from './adapters/anthropic.js';
export {
  fromOpenAIChat,
  toOpenAIChatResult,
  fromOpenAIResponses,
  toOpenAIResponsesResult,
  type OpenAIToolMessage,
  type OpenAIFunctionCallOutput,
} from './adapters/openai.js';
export { fromMcp, toMcpResult, toMcpResponse, type McpCallToolResult, type McpResultOptions } from './adapters/mcp.js';
export type {
  AuditRecord,
  CheckOptions,
  Constraint,
  Decision,
  Executor,
  GuardDecision,
  GuardPolicy,
  RateLimit,
  RuleName,
  RunOptions,
  RunResult,
  ToolCall,
  ToolOutcome,
  ToolRule,
  Validator,
} from './types.js';
export { VERSION } from './version.js';
