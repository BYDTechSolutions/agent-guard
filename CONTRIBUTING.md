# Contributing

Thanks for helping. Issues and pull requests are welcome at
[github.com/BYDTechSolutions/agent-guard](https://github.com/BYDTechSolutions/agent-guard).

## Setup

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Node.js 20 or later.

## Rules

- Tests never call a model API or reach the network. Adapter tests use fixture
  payloads in `test/fixtures/`, shaped after the providers' documentation.
- Adapter shapes follow the providers' own documentation, linked in the README.
  If you change one, link the part of the documentation that supports the change,
  and update the fixture.
- A bypass of `pathUnder`, `hostAllowed` or `sqlReadOnly` is a security issue:
  report it privately (see [SECURITY.md](SECURITY.md)), then add the case to the
  tests with the fix.
- When in doubt, deny. A check that cannot decide, or a user function that throws,
  must lead to a denial, never to an allowed call.
- No runtime dependencies without a strong reason, stated in the README.
- Add a line to `CHANGELOG.md` under "Unreleased".
- American English in code, messages and docs.
