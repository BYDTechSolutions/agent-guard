# @bydtech/agent-guard

A small policy layer between an LLM agent and its tools: allow, deny or ask a human before each tool call runs, with argument checks, rate limits and an audit log.

[![npm version](https://img.shields.io/npm/v/@bydtech/agent-guard.svg)](https://www.npmjs.com/package/@bydtech/agent-guard)
[![CI](https://github.com/BYDTechSolutions/agent-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/BYDTechSolutions/agent-guard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why it exists

An agent runs whatever tool calls the model writes. The model can be wrong, and it can be talked into things by text it reads in a web page, an email or a file. Most agent code checks nothing between "the model asked" and "the tool ran". This package is that check, in one place: which tools may run, with which arguments, how often, and which ones need a person to say yes first. A denied call comes back to the model as a normal tool result ("denied: reason"), so the loop carries on instead of crashing.

It works with any agent code. It imports no SDK: adapters read and write the plain JSON shapes of the Anthropic Messages API, the OpenAI Chat Completions and Responses APIs, and MCP.

## Install

```sh
npm install @bydtech/agent-guard
```

Node.js 20 or later. No runtime dependencies.

## Quick start

```js
import { defineGuard, fromAnthropic, toAnthropicMessage, pathUnder, hostAllowed } from '@bydtech/agent-guard';

const guard = defineGuard({
  default: 'deny', // tools not listed here never run
  maxCallsPerRun: 50,
  auditFile: 'agent-audit.jsonl',
  tools: {
    read_file: {
      schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      constraints: [pathUnder('/srv/workspace')],
    },
    fetch_url: {
      constraints: [hostAllowed(['api.github.com', '*.example.com'])],
      rateLimit: { max: 10, windowMs: 60_000 },
    },
    send_email: 'approve',
    delete_repo: 'deny',
  },
});

const tools = {
  read_file: async ({ path }) => `contents of ${path}`,
  fetch_url: async ({ url }) => (await fetch(url)).text(),
  send_email: async ({ to }) => ({ sent: true, to }),
};

// `response` is what the Messages API returned with stop_reason "tool_use".
const response = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: '../../etc/passwd' } }],
};

const results = [];
for (const call of fromAnthropic(response)) {
  results.push(
    await guard.run(call, tools[call.name] ?? (() => 'no such tool'), {
      approve: async (call) => false, // ask a person here: a prompt, a button, a queue
    }),
  );
}

console.log(toAnthropicMessage(results));
// { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01',
//   content: 'denied: path "../../etc/passwd" resolves outside the allowed directory', is_error: true }] }
```

Dry-run a policy from the terminal, without an agent:

```sh
npx agent-guard check --policy examples/policy.mjs --call '{"name":"read_file","args":{"path":"../.env"}}'
# deny: path "../.env" resolves outside the allowed directory (rule: constraint)
```

[`examples/`](examples) has a sample policy and a runnable agent turn (`node examples/agent-loop.mjs` after `npm run build`).

## CLI reference

```
agent-guard check --policy <file.mjs> --call '<json>' [--session <id>] [--json]
agent-guard audit <file.jsonl> [--json]
```

### `agent-guard check`

Loads the policy module and prints the decision for one call, without counting it against any limit. The module's default export is either a policy object (what you pass to `defineGuard`) or a guard. The call is `{"name": "...", "args": {...}}`; `"arguments"` (an object, or a JSON string as OpenAI sends it) and `"input"` are read as the arguments too. `--call -` reads the call from stdin.

### `agent-guard audit`

Summarizes an audit log written with the `auditFile` option: decisions by tool and by outcome, approvals granted and declined, and every denial reason with its count. Lines that are not audit records are skipped and listed. `-` reads stdin; `--json` prints the summary as JSON.

```
$ npx agent-guard audit agent-audit.jsonl
6 decisions: 1 allowed, 3 denied, 2 sent for approval
from 2026-10-16T09:00:01.000Z to 2026-10-16T09:00:08.000Z
approvals: 1 approved, 1 declined

tool        allow  deny  approve  total
read_file       1     2        0      3
rm              0     1        0      1
send_email      0     0        2      2

denials:
     2  read_file [validate] invalid arguments: no parent paths
     1  rm [default] rm is not an allowed tool
     1  send_email [approval] approval was declined
```

### Exit codes

| Code | `check` | `audit` |
|---|---|---|
| `0` | allowed | summary printed |
| `1` | denied | |
| `2` | usage or input error: unknown option, invalid JSON, policy that fails to load or is invalid | usage error or unreadable file |
| `3` | needs approval | |

## API reference

### `defineGuard(policy) → Guard`

Builds a guard. Throws `PolicyError` for a policy it cannot enforce: an unknown field (a typo such as `rateLimt`), an unsupported schema keyword, a bad limit. Mistakes surface at startup, not as a silently allowed call.

| Method | What it does |
|---|---|
| `guard.check(call, { record?, audit? })` | Returns `{ decision, reason, rule, tool }`. `decision` is `allow`, `deny` or `approve`. Unless `record: false`, a call that is not denied counts against rate limits and run limits (calls sent for approval count too, so a model cannot flood a person with requests). `audit: false` skips `onDecision` and the audit file. |
| `guard.run(call, executor, { approve? })` | Checks the call. On `approve`, awaits `approve(call, decision)` and runs only on `true` (anything else, a throw, or no `approve` function counts as no). Runs `executor(args, call)` only when allowed or approved, with the original, unredacted arguments. Returns `{ id, tool, ran, decision, reason, rule, output?, content, isError }`, where `content` is the output as text (strings as they are, anything else as JSON) or `"denied: <reason>"`. Errors thrown by the executor are not caught. |
| `guard.reset(session?)` | Starts a new run: clears per-run call counts for one session, or all. Rate-limit windows are kept. |

A call is `{ id?, name, args, argsError?, session? }`. The adapters build it; `argsError` is set when arguments arrived as a JSON string that did not parse, and such a call is denied.

`rule` says which part of the policy decided: `default` (tool not listed), `action`, `input` (no name, unparseable arguments), `schema`, `validate`, `constraint`, `rateLimit`, `maxCalls`, `maxCallsPerRun`, or `approval` (the person's answer, in `run`).

### Adapters

| Provider | Read calls | Build results |
|---|---|---|
| Anthropic Messages API | `fromAnthropic(responseOrMessageOrContent, session?)` reads `tool_use` blocks | `toAnthropicResult(r)` → `{ type: 'tool_result', tool_use_id, content, is_error? }`; `toAnthropicMessage(results, text?)` → the user message, results first |
| OpenAI Chat Completions | `fromOpenAIChat(completionOrMessageOrToolCalls, session?)` reads `tool_calls` (`function`, and `custom` with its raw `input`) and parses `arguments` | `toOpenAIChatResult(r)` → `{ role: 'tool', tool_call_id, content }` |
| OpenAI Responses API | `fromOpenAIResponses(responseOrOutput, session?)` reads `function_call` items by `call_id` | `toOpenAIResponsesResult(r)` → `{ type: 'function_call_output', call_id, output }` |
| MCP | `fromMcp(request, session?)` reads a JSON-RPC `tools/call` request, or returns `null` | `toMcpResult(r, { resultType? })` → `{ content: [{ type: 'text', text }], isError }`; `toMcpResponse(id, r)` wraps it in the JSON-RPC response |

Each builder takes a `RunResult` or any `{ id, content, isError }`. Shapes were checked against the providers' documentation:

- Anthropic: [handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls) (`tool_use` fields, `tool_result` with `is_error`, results first in the user message) and [define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools).
- OpenAI: [Chat Completions reference](https://developers.openai.com/api/reference/resources/chat) (`tool_calls[].function.arguments` is a JSON string the model "does not always" get right; the `tool` message), [Responses reference](https://developers.openai.com/api/reference/resources/responses) (`function_call` with `call_id`; `function_call_output`), and the [function calling guide](https://developers.openai.com/api/docs/guides/function-calling).
- MCP: [tools, revision 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) and the [latest revision](https://modelcontextprotocol.io/specification/latest/server/tools) (2026-07-28 at the time of writing, which adds `resultType: "complete"`; pass `{ resultType: true }` to include it). A denial is returned as a tool execution error (`isError: true`), which the specification says clients should pass to the model, not as a JSON-RPC protocol error.

### Constraints

Each returns a function for a rule's `constraints` array. The value is read from the argument named by `arg` (a property name, a dotted path like `"target.url"`, or a function); an array value is checked item by item; a missing argument is denied unless `optional: true`.

| Helper | Default `arg` | Checks |
|---|---|---|
| `pathUnder(root, { arg?, platform?, allowEncoded?, resolveSymlinks?, optional? })` | `path` | The path stays inside `root` after normalization. |
| `hostAllowed(hosts, { arg?, schemes?, allowUserinfo?, optional? })` | `url` | The URL's host is on the allowlist. |
| `sqlReadOnly({ arg?, denyWords?, optional? })` | `sql` | One read-only `SELECT` or `WITH ... SELECT`. |

The checks are also exported on their own: `checkPath(root, input, options)` → `{ ok, resolved }` or `{ ok: false, reason }`, `isPathInside`, `checkUrlHost(hosts, input, options)`, `checkReadOnlySql(sql, options)` → reason or `null`.

Write your own as `(args, call) => reason | null`.

### Schema validation

`compileSchema(schema)` returns a validator; `validateSchema(schema, value)` validates once; `formatSchemaErrors(errors)` makes one line. Supported keywords: `type` (one or a list), `enum`, `const`, `minLength`, `maxLength` (in code points), `pattern` (with the `u` flag, unanchored as JSON Schema specifies), `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum` (number form), `properties`, `required`, `additionalProperties` (boolean or schema), `items` (one schema), `minItems`, `maxItems`, and boolean schemas. Annotations (`title`, `description`, `default`, `examples`, `format`, `$schema`, `$id`, `$comment`, `deprecated`, `readOnly`, `writeOnly`) are accepted and not checked, as JSON Schema 2020-12 treats `format` by default. **Any other keyword throws** (`anyOf`, `oneOf`, `$ref`, `uniqueItems`, ...): a schema never looks stricter than it is. Use `validate` for the rest.

### Redaction

`redact(value, options)` returns a deep copy with secrets replaced; `redactString(text, options)` does one string. The guard applies it to the arguments and the reason of every audit record; the executor always gets the original arguments.

- Values under secret-looking keys are replaced whole: `password`, `token`, `api_key`, `authorization`, `cookie`, `client_secret`, `private_key` and more (`DEFAULT_SECRET_KEYS`), compared without case, `-` or `_`; names of five or more characters also match as a suffix (`x-api-key`, `db_password`). Empty values are kept, so a log shows they were empty.
- Inside every string (`DEFAULT_SECRET_PATTERNS`): PEM private keys, `Bearer` and `Basic` credentials, JWTs, `sk-` keys, AWS access key ids, GitHub, Slack, Google and Stripe live tokens, and the password in `scheme://user:password@host`.
- Strings longer than 2000 characters are cut. Cycles become `"[Circular]"`.

### Audit log

`parseAuditLog(text)`, `summarizeAudit(records)` and `formatAuditSummary(summary)` are what `agent-guard audit` uses. One record:

```json
{"time":"2026-10-16T09:00:05.000Z","event":"check","tool":"send_email","callId":"toolu_03","session":"default","decision":"approve","rule":"action","reason":"send_email needs approval","args":{"to":"team@example.com","api_key":"[REDACTED]"}}
```

`event` is `check` for the policy decision and `approval` for the person's answer to an `approve`.

All types are exported (`GuardPolicy`, `ToolRule`, `ToolCall`, `GuardDecision`, `RunResult`, `AuditRecord`, ...).

## Configuration

### Policy

| Field | Default | Meaning |
|---|---|---|
| `tools` | required | A rule, or just `'allow'` / `'deny'` / `'approve'`, per tool name. |
| `default` | `'deny'` | What happens to a tool that is not listed: `'deny'` or `'allow'`. |
| `maxCallsPerRun` | none | Most calls of any tool per session until `guard.reset()`. |
| `onDecision` | none | Called with every audit record (arguments redacted). |
| `auditFile` | none | Appends every audit record to this file as one JSON line (synchronously, so lines stay in order). |
| `redact` | `{}` (on) | `{ keys?, patterns?, replacement?, maxStringLength? }` to extend redaction, or `false` to log arguments as they are. |
| `clock` | `Date.now` | Milliseconds since the epoch; replace it in tests. |

### Rule

| Field | Default | Meaning |
|---|---|---|
| `action` | `'allow'` | What to do once every check passes: `'allow'`, `'deny'` or `'approve'`, or `(args, call) => decision` to decide per call. |
| `schema` | none | A JSON Schema (the subset above) the arguments must match. |
| `validate` | none | `(args, call) =>` `true` or nothing to pass; `false`, a string or a string array to deny with that reason. |
| `constraints` | `[]` | Functions `(args, call) => reason | null`, such as `pathUnder`, `hostAllowed`, `sqlReadOnly`. |
| `rateLimit` | none | `{ max, windowMs, per? }`: at most `max` calls in any `windowMs` window. `per: 'session'` (default) gives each session its own window; `per: 'tool'` shares one. |
| `maxCalls` | none | Most calls of this tool per session until `guard.reset()`. |

Checks run in this order and the first failure decides: tool listed (else `default`), `action: 'deny'`, `schema`, `validate`, `constraints`, `action`, `maxCallsPerRun`, `maxCalls`, `rateLimit`. Argument checks come first so an invalid call does not use up a limit. A `validate`, constraint or `action` function that throws denies the call.

## How it works, and its limits

**It decides whether a call runs. It does not isolate what the tool does.** Once a call is allowed, the tool runs with your process's permissions. Run tools that touch files, networks or databases with the least access they need (a container, a read-only database role, a scoped API token), and treat this package as the gate in front, not the walls around.

- **Paths.** `pathUnder` resolves relative paths against `root` (not the working directory) and checks the result is `root` or below it, with a separator boundary, so `/srv/work-evil` is not inside `/srv/work`. It refuses NUL bytes, `~`, and percent-encoded dots, separators and NUL (a tool that later URL-decodes would see `../`). On POSIX it treats `\` as a separator and refuses Windows drive and UNC paths; with `platform: 'win32'` it refuses drive-relative (`C:foo`) and device (`\\?\`, `\\.\`) paths and any other `:`, and compares without case. **The check is lexical by default**: a symbolic link inside the root that points outside is not detected. `resolveSymlinks: true` resolves links on the root and on the deepest existing part of the path, but a link created between the check and the tool's use (a race) still gets through.
- **Hosts.** `hostAllowed` parses with the WHATWG `URL` parser, the one Node's `fetch` uses, so `https://allowed.com@evil.com` is `evil.com` (and refused for carrying credentials), IDN hosts compare in punycode (a Cyrillic lookalike does not match), numeric IP forms are normalized, and a trailing dot is ignored. A non-default port must be on the entry (`host:8443`, or `host:*`). It does not resolve DNS: an allowed name that resolves to an internal address, or a server that redirects elsewhere, is beyond a string check. Disable or re-check redirects in the tool itself.
- **SQL.** `sqlReadOnly` is a string check, not a parser. Dialects disagree on comments, escapes and quoting, and that disagreement is how a write hides inside what looks like a string, so it refuses what it cannot read the same way in every dialect: comments, backslashes inside quotes, dollar-quoted strings, unterminated quotes. Then it requires `SELECT` or `WITH` first, one statement, and none of the write, lock or session words in `SQL_DENIED_WORDS` outside quotes. It will refuse some harmless queries. It does not know which functions have side effects (`denyWords` adds names); use a read-only database role as well.
- **Schemas.** The validator covers the keywords listed above and refuses others rather than ignoring them. Patterns come from your policy; a slow regular expression is your own to avoid.
- **Rate limits and run counts** live in memory, in one process. They reset when the process restarts and are not shared between instances. A sliding-window log keeps one timestamp per call inside the window.
- **Approvals.** The guard asks your `approve` function and waits; how a person is asked, and how long you wait, is up to your code. It fails closed: no function, a throw, or any answer other than `true` is a no.
- **Redaction** matches key names and known token formats. It cannot recognize every secret: a password in a field called `note` gets through unless it matches a pattern. Add `keys` and `patterns` for your own formats, and keep audit files private.
- **The model sees denial reasons.** They are written for it to correct course ("path ... resolves outside the allowed directory"), and they name the argument that failed. Do not put secrets in policy reasons.
- **No runtime dependencies.** It uses `node:fs` (audit file, optional symlink resolution), `node:path`, `node:url` and `node:util` `parseArgs` for the CLI.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

---

Maintained by [BYD Tech](https://bydtech.in), a software studio that builds MVPs, AI agents, and web & mobile apps.
