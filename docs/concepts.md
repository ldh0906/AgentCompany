# Concepts

## The CEO and the orchestrator

There are three kinds of actors:

| Actor | Can | Cannot |
|---|---|---|
| **CEO (you)** | approve, reject, attest, cancel, change access levels, record decisions | — |
| **Orchestrator (code)** | move tickets, run verify commands, create worktrees, integrate after approval | approve anything, decide product rules |
| **Employees (CLIs)** | propose: reports, reviews, claims, ticket drafts | move tickets, approve their own work, create tickets, touch your repo |

The ticket state machine (`src/core/ticket-machine.ts`) checks the actor of every command. A randomized property test drives thousands of command sequences and asserts that no path reaches `integrating` or `done` without a CEO approval, and that no employee reviews their own work.

## Claims vs. evidence

An employee's report is a **claim**. Evidence is produced by the system:

| Evidence | Produced by | Strength |
|---|---|---|
| `mockup` | — | 0 |
| `inspection` | reviewer reading the diff | 0 |
| `static_check` | a verify command you configured | 1 |
| `unit_test` | a verify command you configured | 2 |
| `runtime` | a verify command you configured | 3 |
| `human_attest` | you, bound to the exact submission | 4 |

A requirement names the minimum strength. A reviewer can only cite evidence IDs that exist for the current submission, and evidence attached to one requirement cannot be reused for another.

## Scope, isolation and integration

- Your repo is cloned into a **bare mirror without remotes**. Employees work in per-ticket worktrees of the mirror.
- After a run, the orchestrator commits the worktree itself and checks: changed paths ⊆ write scope, protected paths untouched, no unexpected git refs in the mirror, your repo's working tree content and refs unchanged.
- Verify commands run in a clean detached checkout; the same checks run before and after them.
- Tickets whose write scopes overlap run one after another.
- Integration fetches the **exact approved SHA**. Approvals are bound to (base, head, changed paths) and are single-use.

## Blind cross-review

Review tickets (`type: review`) run a four-step protocol:

1. **Blind analysis.** Every participant analyses the same material without seeing anyone else's output and registers claims with sources.
2. **Cross-verdicts.** Each claim is judged by someone other than its author (another CLI when possible). The author is hidden. Verdicts: agree, partial, disagree, insufficient.
3. **Mandatory rebuttal.** The author must answer every non-agree verdict: keep, narrow, revise, withdraw, or "CEO decides". The ticket cannot advance until every answer is in.
4. **Code synthesis.** No LLM summarizes and no majority vote decides. Disputes the author keeps are **escalated** to you with both sides; everything else is resolved.

If you reject the result, the next round starts from scratch with your reason attached.

## Decisions

Only CEO decisions become `current`, and only `current` decisions are given to employees as binding. Old decisions are never deleted: they become `past`, `superseded` or `withdrawn`.

## Continuity

- CLIs run under a detached **shim** that survives the dashboard process and writes output and exit codes to disk.
- On start, the orchestrator verifies the hash-chained event log (and its out-of-database checkpoint), re-attaches to live runs, and collects runs that finished while it was down.
- A run that was being prepared when the process died is abandoned explicitly, so it can never start late and run twice.
