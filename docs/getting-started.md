# Getting started with real CLIs

This guide takes you from zero to a first reviewed change made by your own Claude Code and Codex subscriptions.
If you just want to see the flow, run `npm run demo` instead (no subscription needed).

## 1. Requirements

- Node.js 22.18 or newer (24 LTS recommended)
- git 2.30+
- At least two of: [Claude Code](https://docs.anthropic.com/claude-code), [Codex CLI](https://github.com/openai/codex), [Antigravity CLI](https://antigravity.google/docs/cli) (`agy`).
  Two employees are the minimum because nobody may review their own work.

## 2. Install and check

```bash
npm install -g agent-company      # or: clone, npm install, npm run build, npm link
agent-company doctor
```

`doctor` lists every CLI it found, its version, and whether it is logged in **inside the app-only profile**.

## 3. Log in once per app-only profile

Employees run in separate CLI profiles under your data folder (default `~/AgentCompany/profiles`). Your personal plugins, hooks and MCP servers are not loaded there.
Log in once per CLI, in your own terminal (Agent Company never handles your credentials):

**Windows (PowerShell)**

```powershell
$env:CLAUDE_CONFIG_DIR="$HOME\AgentCompany\profiles\claude"; claude auth login
$env:CODEX_HOME="$HOME\AgentCompany\profiles\codex"; codex login
```

**macOS / Linux**

```bash
CLAUDE_CONFIG_DIR=~/AgentCompany/profiles/claude claude auth login
CODEX_HOME=~/AgentCompany/profiles/codex codex login
```

Antigravity has no documented profile variable yet; it uses your normal `agy` login. Run `agy` once interactively.

Prefer to use your normal profiles? Start with `agent-company start --user-profiles` (not recommended: personal hooks and MCP servers will run inside employees).

## 4. Start the company

```bash
agent-company start
```

The dashboard opens at `http://127.0.0.1:4777` with a one-time token. Nothing listens on other interfaces.

## 5. Register a project

**Projects → Register project**

| Field | What to put |
|---|---|
| Repository path | A local git repo. It is never modified before your approval. |
| Base branch | Usually `main`. |
| Integration | *Branch only* (you merge) or *auto merge after approval* (fast-forward only; never touches a dirty working tree). |
| Verify commands | One per line: `label | evidence | command`, e.g. `Unit tests | unit_test | npm test`. These produce the evidence reviewers must cite. |
| Protected paths | Globs nobody may touch without you, e.g. `README.md`, `docs/design/README.md`. |
| Document rules | Rules injected into every task (source of truth, how to treat undecided numbers…). |

## 6. Hire employees

**Team → Add employee.** Pick CLI, model and access level. A good first team:

| Name | CLI | Roles | Access |
|---|---|---|---|
| Builder | Claude Code | implementer | 2 · write, ask for commands |
| Reviewer | Codex | QA | 1 · read only (reviews are always read-only anyway) |
| Chief of staff | Codex or Claude | chief of staff, recorder | 1 · read only |

Reviewers are assigned from a different CLI than the implementer when possible.

## 7. First ticket

Either type a request in **Ask the team** (the chief of staff drafts tickets; you confirm) or click **New ticket**.
Give each requirement the minimum evidence that proves it. A `unit_test` requirement can only pass if a verify command of that type exists and passes.

Then watch the board: *working → verifying → in review → awaiting CEO*. Approve in the inbox. With *branch only* you get `ac/T-1` in your repo.

## 8. When something stops

Tickets never fail silently. Every hold has a reason and a next step on the dashboard:

| Hold | Typical cause | What you do |
|---|---|---|
| Needs permission | out-of-scope edit, protected path, git ref tampering, verify command touched your repo | Inspect the diff; cancel or release |
| Needs CEO decision | max rounds reached, employee asked a question, evidence insufficient | Decide, attest, or change the ticket |
| Usage limit | subscription limit hit | Release when the limit resets |
| Waiting on dependency | an earlier ticket is not done | Nothing: released automatically |

## 9. Restart safely

`Ctrl+C` stops the dashboard. Employee runs keep going; the next `agent-company start` re-attaches to them or collects their results. Nothing is run twice.

## 10. Remove everything

```bash
agent-company uninstall          # preview
agent-company uninstall --yes
```
