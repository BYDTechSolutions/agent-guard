// A sample policy for a coding agent. Try it without an agent:
//   npx agent-guard check --policy examples/policy.mjs --call '{"name":"read_file","args":{"path":"../.env"}}'
import { hostAllowed, pathUnder, sqlReadOnly } from '@bydtech/agent-guard';

const workspace = process.env.WORKSPACE ?? process.cwd();

export default {
  default: 'deny',
  maxCallsPerRun: 50,
  tools: {
    read_file: {
      schema: {
        type: 'object',
        properties: { path: { type: 'string', maxLength: 1024 } },
        required: ['path'],
        additionalProperties: false,
      },
      constraints: [pathUnder(workspace)],
    },
    write_file: {
      action: 'approve',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string', maxLength: 200000 } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      constraints: [pathUnder(workspace)],
    },
    fetch_url: {
      schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      constraints: [hostAllowed(['api.github.com', '*.npmjs.org'])],
      rateLimit: { max: 10, windowMs: 60_000 },
    },
    run_sql: {
      schema: { type: 'object', properties: { sql: { type: 'string', maxLength: 10000 } }, required: ['sql'] },
      constraints: [sqlReadOnly()],
      maxCalls: 20,
    },
    delete_file: 'deny',
  },
};
