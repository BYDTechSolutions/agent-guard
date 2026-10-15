/**
 * OpenAI Chat Completions (`tool_calls` on the assistant message, answered by
 * `role: "tool"` messages) and Responses API (`function_call` output items, answered
 * by `function_call_output` input items).
 * https://developers.openai.com/api/reference/resources/chat
 * https://developers.openai.com/api/reference/resources/responses
 * https://developers.openai.com/api/docs/guides/function-calling
 */
import type { ToolCall, ToolOutcome } from '../types.js';
import { isRecord, parseArguments, requireId } from './shared.js';

/** A Chat Completions `role: "tool"` message. */
export interface OpenAIToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

/** A Responses API `function_call_output` input item. */
export interface OpenAIFunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

/**
 * Reads the tool calls from a chat completion (the first choice), an assistant
 * message, or its `tool_calls` array. `function` calls have their JSON `arguments`
 * parsed; when that fails the call carries `argsError` and the guard denies it.
 * `custom` tool calls are read with their raw `input` string as `args`.
 */
export function fromOpenAIChat(value: unknown, session?: string): ToolCall[] {
  let toolCalls: unknown = value;
  if (isRecord(value)) {
    if (Array.isArray(value.choices)) {
      const first = value.choices[0];
      toolCalls = isRecord(first) && isRecord(first.message) ? first.message.tool_calls : undefined;
    } else {
      toolCalls = value.tool_calls;
    }
  }
  if (!Array.isArray(toolCalls)) return [];
  const calls: ToolCall[] = [];
  for (const tc of toolCalls) {
    if (!isRecord(tc)) continue;
    const id = typeof tc.id === 'string' ? tc.id : undefined;
    const extra = session !== undefined ? { session } : {};
    if (tc.type === 'function' && isRecord(tc.function) && typeof tc.function.name === 'string') {
      calls.push({ id, name: tc.function.name, ...parseArguments(tc.function.arguments), ...extra });
    } else if (tc.type === 'custom' && isRecord(tc.custom) && typeof tc.custom.name === 'string') {
      calls.push({ id, name: tc.custom.name, args: tc.custom.input ?? '', ...extra });
    }
  }
  return calls;
}

/** Builds the `role: "tool"` message for one outcome. */
export function toOpenAIChatResult(outcome: ToolOutcome): OpenAIToolMessage {
  return { role: 'tool', tool_call_id: requireId(outcome.id, 'toOpenAIChatResult'), content: outcome.content };
}

/**
 * Reads the `function_call` items from a Responses API response or its `output`
 * array. The call id is `call_id` (what the result must reference), not the item `id`.
 */
export function fromOpenAIResponses(value: unknown, session?: string): ToolCall[] {
  const output = Array.isArray(value) ? value : isRecord(value) ? value.output : undefined;
  if (!Array.isArray(output)) return [];
  const calls: ToolCall[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== 'function_call' || typeof item.name !== 'string') continue;
    calls.push({
      id: typeof item.call_id === 'string' ? item.call_id : undefined,
      name: item.name,
      ...parseArguments(item.arguments),
      ...(session !== undefined ? { session } : {}),
    });
  }
  return calls;
}

/** Builds the `function_call_output` input item for one outcome. */
export function toOpenAIResponsesResult(outcome: ToolOutcome): OpenAIFunctionCallOutput {
  return {
    type: 'function_call_output',
    call_id: requireId(outcome.id, 'toOpenAIResponsesResult'),
    output: outcome.content,
  };
}
