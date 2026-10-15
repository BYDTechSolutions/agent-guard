/**
 * Model Context Protocol: a JSON-RPC `tools/call` request, answered by a result
 * with `content` and `isError`. A denial is a tool execution error (`isError: true`),
 * which the specification says clients should pass to the model, not a JSON-RPC
 * protocol error.
 * https://modelcontextprotocol.io/specification/2025-06-18/server/tools
 * https://modelcontextprotocol.io/specification/latest/server/tools
 */
import type { ToolCall, ToolOutcome } from '../types.js';
import { isRecord } from './shared.js';

/** A `CallToolResult`. */
export interface McpCallToolResult {
  content: { type: 'text'; text: string }[];
  isError: boolean;
  resultType?: 'complete';
}

/** Options for {@link toMcpResult}. */
export interface McpResultOptions {
  /**
   * Add `resultType: "complete"`, which revision 2026-07-28 of the specification
   * puts on every result. Default `false` (earlier revisions have no such field).
   */
  resultType?: boolean;
}

/**
 * Reads a JSON-RPC `tools/call` request. Returns `null` for any other message.
 * The call id is the JSON-RPC `id` as a string; missing `arguments` become `{}`.
 */
export function fromMcp(request: unknown, session?: string): ToolCall | null {
  if (!isRecord(request) || request.method !== 'tools/call' || !isRecord(request.params)) return null;
  const { name, arguments: args } = request.params;
  if (typeof name !== 'string') return null;
  const id = typeof request.id === 'string' || typeof request.id === 'number' ? String(request.id) : undefined;
  return { id, name, args: args ?? {}, ...(session !== undefined ? { session } : {}) };
}

/** Builds the `CallToolResult` for one outcome, as one text content item. */
export function toMcpResult(outcome: ToolOutcome, options: McpResultOptions = {}): McpCallToolResult {
  return {
    ...(options.resultType ? { resultType: 'complete' as const } : {}),
    content: [{ type: 'text', text: outcome.content }],
    isError: outcome.isError === true,
  };
}

/** Wraps {@link toMcpResult} in the JSON-RPC response for request `id`. */
export function toMcpResponse(
  id: string | number,
  outcome: ToolOutcome,
  options: McpResultOptions = {},
): { jsonrpc: '2.0'; id: string | number; result: McpCallToolResult } {
  return { jsonrpc: '2.0', id, result: toMcpResult(outcome, options) };
}
