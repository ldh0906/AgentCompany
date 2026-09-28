# Changelog

## 0.1.0 — first public preview

### Company
- Tickets move only through a pure, property-tested state machine. Employee reports are claims, not transitions.
- Up to 4 active employees, each a Claude Code, Codex, Antigravity or demo CLI with its own model and access level.
- Chief of staff turns a one-line CEO request into ticket drafts from a read-only checkout; the CEO confirms.
- Blind cross-review tickets with a claim ledger: independent analysis, anonymized cross-verdicts, mandatory rebuttal, deterministic synthesis, unresolved disputes escalated to the CEO.
- Decision log with statuses (current, superseded, withdrawn, …); only current decisions bind employees.

### Evidence and review
- The orchestrator commits the worktree itself, checks write scope, protected paths, unexpected git refs and the origin working tree, and runs verify commands in a clean checkout.
- Requirements declare the minimum evidence (`inspection`, `static_check`, `unit_test`, `runtime`, `human_attest`); weaker evidence cannot pass review.
- CEO attestation for things that cannot be verified automatically, bound to the submitted commit.

### Safety
- Your repository is untouched until you approve. Manual mode creates a branch; auto mode merges fast-forward only and never touches a dirty working tree.
- Approvals are single-use and bound to the exact submission.
- Permission relay: Claude (`--permission-prompt-tool`) and Codex (app-server) tool requests can be approved from the dashboard.
- App-only CLI profiles keep personal plugins, hooks and MCP servers out of employee runs.
- Local dashboard: 127.0.0.1 only, per-start token, Host and Origin checks, CSP.

### Reliability
- CLIs run under a detached shim: they survive daemon crashes without popping console windows on Windows.
- Restart recovery re-attaches to live runs or collects finished ones from disk; the hash-chained event log detects tampering.

### Measured CLI facts (Windows 11)
- Claude Code 2.1.202 and Codex 0.153.4: headless JSON, resume by ID, Korean paths and output verified.
- Antigravity 1.2.12: `-p` takes the prompt as a value and ignores stdin; the adapter uses `--print=`.
