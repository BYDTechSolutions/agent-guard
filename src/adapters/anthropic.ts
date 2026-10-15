/**
 * Anthropic Messages API: `tool_use` blocks in the assistant message, answered by
 * `tool_result` blocks in the next user message.
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls
 */
import type { ToolCall, ToolOutcome } from '../types.js';
import { isRecord, requireId } from './shared.js';

/** A `tool_use` content block. */
export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

/** A `tool_result` content block. */
export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: true;
}

/**
 * Reads the tool calls from a Messages API response, an assistant message, or its
 * `content` array. Other blocks (text, thinking, server tools) are skipped.
 */
export function fromAnthropic(message: unknown, session?: string): ToolCall[] {
  const content = Array.isArray(message) ? message : isRecord(message) ? message.content : undefined;
  if (!Array.isArray(content)) return [];
  const calls: ToolCall[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_use' || typeof block.name !== 'string') continue;
    calls.push({
      id: typeof block.id === 'string' ? block.id : undefined,
      name: block.name,
      args: block.input ?? {},
      ...(session !== undefined ? { session } : {}),
    });
  }
  return calls;
}

/** Builds the `tool_result` block for one outcome. `is_error` is set only on errors. */
export function toAnthropicResult(outcome: ToolOutcome): AnthropicToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: requireId(outcome.id, 'toAnthropicResult'),
    content: outcome.content,
    ...(outcome.isError ? { is_error: true as const } : {}),
  };
}

/**
 * Builds the user message that answers every `tool_use` of the previous turn. The
 * results come first in `content`, as the API requires; pass `text` to add a text
 * block after them.
 */
export function toAnthropicMessage(outcomes: ToolOutcome[], text?: string): {
  role: 'user';
  content: (AnthropicToolResultBlock | { type: 'text'; text: string })[];
} {
  return {
    role: 'user',
    content: [...outcomes.map(toAnthropicResult), ...(text ? [{ type: 'text' as const, text }] : [])],
  };
}
