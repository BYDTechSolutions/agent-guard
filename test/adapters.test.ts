import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  defineGuard,
  fromAnthropic,
  fromMcp,
  fromOpenAIChat,
  fromOpenAIResponses,
  hostAllowed,
  pathUnder,
  sqlReadOnly,
  toAnthropicMessage,
  toAnthropicResult,
  toMcpResponse,
  toMcpResult,
  toOpenAIChatResult,
  toOpenAIResponsesResult,
} from '../src/index.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;

describe('Anthropic Messages API', () => {
  const response = fixture('anthropic-response.json');

  it('reads tool_use blocks and skips text and thinking', () => {
    expect(fromAnthropic(response)).toEqual([
      { id: 'toolu_01A09q90qw90lq917835lq9', name: 'read_file', args: { path: 'notes/todo.md' } },
      { id: 'toolu_01B88x71zz61kd420934mp2', name: 'read_file', args: { path: '../../etc/passwd' } },
    ]);
    expect(fromAnthropic((response as { content: unknown[] }).content, 's1')[0]).toMatchObject({ session: 's1' });
  });

  it('returns no calls for messages without tool use', () => {
    expect(fromAnthropic({ role: 'assistant', content: 'Hello' })).toEqual([]);
    expect(fromAnthropic(null)).toEqual([]);
    expect(fromAnthropic({ content: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }] })).toEqual([]);
  });

  it('builds tool_result blocks with results first, then optional text', async () => {
    const guard = defineGuard({ tools: { read_file: { constraints: [pathUnder('/srv/work', { platform: 'posix' })] } } });
    const results = await Promise.all(fromAnthropic(response).map((c) => guard.run(c, () => '- buy milk')));
    expect(toAnthropicMessage(results, 'Continue.')).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_01A09q90qw90lq917835lq9', content: '- buy milk' },
        {
          type: 'tool_result',
          tool_use_id: 'toolu_01B88x71zz61kd420934mp2',
          content: 'denied: path "../../etc/passwd" resolves outside the allowed directory',
          is_error: true,
        },
        { type: 'text', text: 'Continue.' },
      ],
    });
    expect(toAnthropicMessage(results).content).toHaveLength(2);
  });

  it('refuses to build a result without a call id', () => {
    expect(() => toAnthropicResult({ content: 'x' })).toThrow(/no call id/);
  });
});

describe('OpenAI Chat Completions', () => {
  const completion = fixture('openai-chat-completion.json');

  it('reads tool_calls from the first choice and parses the JSON arguments', () => {
    const calls = fromOpenAIChat(completion);
    expect(calls[0]).toEqual({ id: 'call_12345xyz', name: 'fetch_url', args: { url: 'https://api.example.com/v1/status' } });
    expect(calls[1]).toEqual({ id: 'call_67890abc', name: 'fetch_url', args: { url: 'https://api.example.com@evil.example.net/' } });
    expect(calls[2]).toMatchObject({ id: 'call_broken01', name: 'fetch_url', args: '{"url": "https://api.exam', argsError: expect.any(String) });
  });

  it('accepts the message or the tool_calls array, and custom tool calls', () => {
    const message = (completion as { choices: { message: { tool_calls: unknown[] } }[] }).choices[0]!.message;
    expect(fromOpenAIChat(message)).toHaveLength(3);
    expect(fromOpenAIChat(message.tool_calls)).toHaveLength(3);
    expect(fromOpenAIChat([{ id: 'call_c', type: 'custom', custom: { name: 'shell', input: 'ls -la' } }])).toEqual([
      { id: 'call_c', name: 'shell', args: 'ls -la' },
    ]);
    expect(fromOpenAIChat({ role: 'assistant', content: 'hi' })).toEqual([]);
    expect(fromOpenAIChat([{ id: 'x', type: 'function', function: { name: 'f', arguments: '' } }])[0]!.args).toEqual({});
  });

  it('builds role: tool messages, and denies unparseable arguments', async () => {
    const guard = defineGuard({ tools: { fetch_url: { constraints: [hostAllowed(['api.example.com'])] } } });
    const results = await Promise.all(fromOpenAIChat(completion).map((c) => guard.run(c, () => ({ status: 'ok' }))));
    expect(results.map(toOpenAIChatResult)).toEqual([
      { role: 'tool', tool_call_id: 'call_12345xyz', content: '{"status":"ok"}' },
      { role: 'tool', tool_call_id: 'call_67890abc', content: 'denied: URL contains credentials (user@host)' },
      { role: 'tool', tool_call_id: 'call_broken01', content: expect.stringMatching(/^denied: arguments could not be parsed/) },
    ]);
  });
});

describe('OpenAI Responses API', () => {
  const response = fixture('openai-response.json');

  it('reads function_call items by call_id and skips reasoning items', () => {
    const calls = fromOpenAIResponses(response);
    expect(calls.map((c) => c.id)).toEqual(['call_12345xyz', 'call_67890abc']);
    expect(calls[0]!.args).toEqual({ sql: "SELECT id, email FROM users WHERE created_at > '2026-01-01' LIMIT 10" });
    expect(fromOpenAIResponses((response as { output: unknown[] }).output)).toHaveLength(2);
    expect(fromOpenAIResponses({ output: [{ type: 'message', content: [] }] })).toEqual([]);
  });

  it('builds function_call_output items', async () => {
    const guard = defineGuard({ tools: { run_sql: { constraints: [sqlReadOnly()] } } });
    const results = await Promise.all(fromOpenAIResponses(response).map((c) => guard.run(c, () => [{ id: 1 }])));
    expect(results.map(toOpenAIResponsesResult)).toEqual([
      { type: 'function_call_output', call_id: 'call_12345xyz', output: '[{"id":1}]' },
      { type: 'function_call_output', call_id: 'call_67890abc', output: 'denied: only one SQL statement is allowed' },
    ]);
  });
});

describe('MCP tools/call', () => {
  const request = fixture('mcp-tools-call.json');

  it('reads a tools/call request and ignores other methods', () => {
    expect(fromMcp(request)).toEqual({ id: '2', name: 'get_weather', args: { location: 'New York' } });
    expect(fromMcp({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'ping' } })).toEqual({ id: 'a', name: 'ping', args: {} });
    expect(fromMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).toBeNull();
    expect(fromMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call' })).toBeNull();
  });

  it('answers with a result, and a denial as a tool execution error', async () => {
    const guard = defineGuard({ tools: { get_weather: { rateLimit: { max: 1, windowMs: 60_000 } } } });
    const call = fromMcp(request)!;
    const first = await guard.run(call, () => 'Partly cloudy, 72°F');
    const second = await guard.run(call, () => 'unused');
    expect(toMcpResponse(2, first)).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: 'Partly cloudy, 72°F' }], isError: false },
    });
    expect(toMcpResult(second)).toEqual({
      content: [{ type: 'text', text: 'denied: get_weather is limited to 1 calls per 1m; retry in 60s' }],
      isError: true,
    });
    expect(toMcpResult(first, { resultType: true })).toMatchObject({ resultType: 'complete' });
  });
});
