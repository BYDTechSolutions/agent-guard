# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-16

### Added

- `defineGuard(policy)` with `check`, `run` and `reset`: per-tool `allow`, `deny` and `approve` (or a function deciding per call), a default for unlisted tools (deny unless set), and policy errors at definition time for unknown fields and unsupported schema keywords.
- Argument checks: a JSON Schema subset validator (`type`, `enum`, `const`, string, number, object and array keywords) that refuses unsupported keywords, user `validate` functions, and constraints `pathUnder`, `hostAllowed` and `sqlReadOnly`. A check that throws denies the call.
- Limits: sliding-window rate limits per tool and session (or shared), calls per tool per run, calls per run, with an injectable clock.
- `run` asks an approval callback for `approve` decisions, fails closed, and returns a denial as a tool result (`"denied: <reason>"`) instead of throwing.
- Adapters, with no SDK imports, for Anthropic `tool_use`/`tool_result`, OpenAI Chat Completions `tool_calls` and `role: "tool"` messages, OpenAI Responses `function_call`/`function_call_output`, and MCP `tools/call`.
- Audit records for every decision and approval, with secrets redacted, to `onDecision` and an optional JSONL file.
- CLI: `agent-guard check` dry-runs a call against a policy module; `agent-guard audit` summarizes an audit log.

[Unreleased]: https://github.com/BYDTechSolutions/agent-guard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/BYDTechSolutions/agent-guard/releases/tag/v0.1.0
