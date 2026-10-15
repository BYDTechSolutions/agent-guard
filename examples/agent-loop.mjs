// One turn of an agent loop with the Anthropic Messages API shape, with no API call:
// the "model response" below is a fixed sample. Run it after `npm run build`:
//   node examples/agent-loop.mjs
import { defineGuard, fromAnthropic, pathUnder, toAnthropicMessage } from '@bydtech/agent-guard';

const guard = defineGuard({
  default: 'deny',
  maxCallsPerRun: 20,
  onDecision: (record) => console.error('audit', JSON.stringify(record)),
  tools: {
    read_file: {
      schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      constraints: [pathUnder('/srv/workspace', { platform: 'posix' })],
    },
    send_email: { action: 'approve', rateLimit: { max: 5, windowMs: 60 * 60 * 1000 } },
  },
});

// What the model sent back (stop_reason: "tool_use").
const response = {
  role: 'assistant',
  stop_reason: 'tool_use',
  content: [
    { type: 'text', text: 'Let me read the notes and email the summary.' },
    { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: 'notes/todo.md' } },
    { type: 'tool_use', id: 'toolu_02', name: 'read_file', input: { path: '../../etc/passwd' } },
    { type: 'tool_use', id: 'toolu_03', name: 'send_email', input: { to: 'team@example.com', api_key: 'sk-example-not-a-real-key' } },
    { type: 'tool_use', id: 'toolu_04', name: 'delete_repo', input: { name: 'main' } },
  ],
};

// Your real tools.
const tools = {
  read_file: async ({ path }) => `contents of ${path}`,
  send_email: async ({ to }) => ({ sent: true, to }),
};

// Ask a person. Here: a fixed answer; in an app, a prompt, a Slack button, a queue.
const approve = async (call) => {
  console.error(`approval requested for ${call.name}`);
  return false;
};

const results = [];
for (const call of fromAnthropic(response)) {
  const executor = tools[call.name] ?? (() => { throw new Error(`no executor for ${call.name}`); });
  results.push(await guard.run(call, executor, { approve }));
}

// Send this back as the next user message; the model reads each denial and carries on.
console.log(JSON.stringify(toAnthropicMessage(results), null, 2));
