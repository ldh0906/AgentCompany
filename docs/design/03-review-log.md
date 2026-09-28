# Independent review log

Agent Company asks you to never trust an agent's "done" and to have a different model review every change.
This project was built the same way: code written by Claude (and two Codex workers) was reviewed by Codex (`gpt-6-astra`, high reasoning, read-only sandbox), and every finding had to be answered with a fix **and a regression test** before the next round.

| Round | Verdict | Findings | Outcome |
|---|---|---|---|
| 1 | not approvable | 7 P1, 5 P2 | all fixed; tests in `test/e2e/review-fixes.test.ts` |
| 2 | not approvable | 6 of 12 only partially fixed, 4 regressions introduced by the fixes | all fixed; tests in `test/e2e/review-fixes-2.test.ts` |
| 3 | not approvable | 4 partial, 5 new P1 | all fixed; tests in `test/e2e/review-fixes-3.test.ts` |
| 4 | see below | | |

The rounds are the product's own protocol, applied to itself: independent review → the author must answer every objection → no majority vote, the CEO decides what is acceptable.

## What the reviews caught (selection)

**Round 1**
- Verify commands (`npm test`) execute code written by an employee before approval; test code could write to your repository undetected. → Before/after comparison of the origin repository and refs, quarantine on change.
- CEO attestation for requirement R1 could be cited as evidence for R2.
- A ticket could be cancelled while its integration was running.
- Integration fetched a branch *name* after checking its SHA (time-of-check/time-of-use).
- Runs left in `prepared` state were ignored by crash recovery → possible duplicate run.
- Run result and ticket transition were committed separately.
- `SRC/private/x` bypassed a `src/private/**` protection on case-insensitive filesystems.

**Round 2**
- The origin "fingerprint" compared only `HEAD` and `git status`: re-editing an already modified file went unnoticed. → Content hashes of diffs and untracked files.
- A pinned temporary ref is still a mutable ref. → Fetch the exact SHA; move origin refs with compare-and-swap.
- A checkpoint write failure after `COMMIT` triggered `ROLLBACK` on a finished transaction.
- Appending a new event after deleting the log tail overwrote the evidence.
- Research reports could reuse a CEO attestation from a previous round. → Evidence is scoped to the submission.

**Round 3**
- Resetting a ref to an old "expected" value hid tampering. → Only `from → to` moves recorded by the orchestrator during the run's window are exempt.
- Merge re-verification that touched the repository was downgraded to a branch integration instead of stopping.
- Verify commands had no crash recovery and could reuse a previous attempt's `exit.json`.
- A failed post-run check was treated as a normal submission.
- Integration could move a branch checked out in a *linked* worktree of your repository.
- The single-instance daemon lock was not atomic.

## Also found by tests and dogfooding (not by the reviewer)

- Node on Windows puts child processes in a kill-on-close Job Object: when the dashboard died, employees died too. → Detached shim.
- `detached` processes on Windows have no console, so every `git`/shell they spawn pops a console window. → The shim gives the CLI a hidden console.
- `npm.cmd` was resolved to `npm-prefix.js` instead of `npm-cli.js`.
- Two concurrent tickets flagged each other's legitimate commits as tampering.
- Waiting on an overlapping write scope spammed the append-only audit log.
- Antigravity's `-p` takes the prompt as a value and ignores stdin (measured on 1.2.12).
