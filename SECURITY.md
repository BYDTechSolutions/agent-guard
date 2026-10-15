# Security policy

## Reporting a vulnerability

Please email **sales.bydtech@gmail.com** with the details, instead of opening a
public issue. We will acknowledge the report and keep you posted on the fix.

## Scope

In scope: a tool call that the policy should deny but the guard allows. For
example, a path that passes `pathUnder` and resolves outside the root, a URL that
passes `hostAllowed` with a host not on the list, a statement that passes
`sqlReadOnly` and writes, a schema that accepts what it should refuse, or a secret
in a known format that reaches the audit log unredacted.

Out of scope: what an allowed tool does once it runs. This package decides whether
a call runs; it does not sandbox the tool. The README's "limits" section lists what
the checks do not cover (symbolic links unless `resolveSymlinks` is on, DNS and
redirects, functions with side effects in SQL, secrets in free-form fields).
