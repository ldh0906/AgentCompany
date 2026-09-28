# Security

## Threat model

Agent Company runs AI coding CLIs on your machine, as your user. It is a **guard-rail and audit system, not a sandbox**.
Processes running as the same OS user can, in principle, read or write anything that user can. Enforcement is layered:

1. **Before the run** — access levels map to each CLI's own permission flags (`--allowedTools`, `-s read-only`, `--sandbox`…). Employees run in app-only CLI profiles so personal plugins, hooks and MCP servers are not inherited. Repository-provided `.claude` settings are not loaded (`--setting-sources user`).
2. **During the run** — (level 2/3) tool calls needing permission are relayed to the CEO in the dashboard; unanswered requests are denied after 10 minutes.
3. **After the run** — the orchestrator commits the worktree itself and checks: changed paths ⊆ write scope, protected paths untouched, no unexpected git refs created/moved in the mirror, the origin repository working tree unchanged. Violations quarantine the submission and hold the ticket for the CEO.

## Guarantees we test

- Messages and reports from employees are data. Nothing is ever executed through a shell; all processes are started with argv arrays.
- A ticket cannot reach `integrating`/`done` without a CEO approval bound to the submission hash (property-tested).
- The assignee can never review their own work.
- The event log is hash-chained; edits and deletions are detected on startup.
- The dashboard listens on `127.0.0.1` only, requires a per-start bearer token, rejects foreign `Host` (DNS rebinding) and `Origin` headers, and sends a strict CSP.
- Agent Company never reads CLI credential files and stores no tokens.

## Known limits

- Anything an employee CLI does inside its run that leaves no trace in git (e.g. reading files outside the worktree, network calls when the CLI allows them) is only constrained by that CLI's own sandbox.
- Antigravity (`agy`) exposes only `--sandbox` and `--dangerously-skip-permissions`; fine-grained control is not possible.

## Reporting

Please open a private security advisory on GitHub rather than a public issue.
