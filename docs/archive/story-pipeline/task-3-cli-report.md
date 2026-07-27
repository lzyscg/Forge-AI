# Task 3 CLI Report

## Scope

Completed the CLI wiring for the execution-lease core from commits `9942f45`,
`80ef494`, and `dc83134`.

- `forge case run <id>` now requires `--runner-token` and forwards the token
  and current CLI PID to `CaseRunner`.
- `forge case resume <id>` now requires `--runner-token` and forwards it to
  the existing-lease resume path.
- Added `forge case abort <id> --runner-token ...`, backed by
  `CaseService.abortCase`.
- Added atomic `forge case transfer-lease <id> --old-runner-token ...
  --new-runner-token ...`, backed by `CaseService.transferExecutionLease`.
- Legacy `case stop` rejects every Case with an active execution lease, so it
  cannot bypass the authorized abort path.
- CLI error paths close repositories before `process.exit`.

## TDD Evidence

Initial RED:

```text
npx vitest run apps/cli/src/case-abort.integration.test.ts
1 file failed, 4 tests failed

run/resume: required --runner-token option was absent
abort: unknown command
transfer-lease: unknown command
```

Focused GREEN after implementation and acceptance expansion:

```text
npx vitest run apps/cli/src/case-abort.integration.test.ts
1 file passed, 8 tests passed
```

The integration suite launches a real Node CLI process. It covers FakePi run,
required run/resume credentials, authorized/wrong/repeated abort, approved and
failed rejection, transfer with stale-token rejection, legacy stop protection,
stable JSON, and plaintext-token absence from stdout, stderr, the Case log,
and SQLite.

## Verification

```text
npx vitest run apps/cli/src/case-abort.integration.test.ts \
  packages/adapters/src/execution-lease.test.ts \
  packages/application/src/execution-lease.test.ts \
  packages/application/src/revision-e2e.test.ts

4 files passed, 46 tests passed
```

```text
npm test
27 files passed, 221 tests passed
```

```text
npm run check
exit 0
```

The full test run emitted only the repository's pre-existing Windows note that
the symlink escape test was skipped for insufficient privileges.

## Full Fix Round 1

Addressed the three Important review findings across the execution owner,
Worker, and legacy stop paths.

- `FORGE_RUNNER_TOKEN` is now a required Worker secret input. Fresh and
  recovery runs forward it with the real Worker PID; the token is never logged
  or stored as plaintext.
- Production `CaseRunner.runCase` and human-input resume require a token.
  Fresh runs atomically acquire an owned lease. Existing leases must atomically
  claim an unowned (`runner_pid = 0`) matching token before work starts.
- An executing runner heartbeats once per second. The timer is unreferenced and
  always cleared. A normal nonterminal return releases only its own PID while
  retaining the token lease; exceptions leave the owner for explicit transfer.
- Lease transfer rotates the token into an unowned lease instead of recording
  the short-lived transfer CLI PID.
- Legacy stop is now one repository/application `BEGIN IMMEDIATE` conditional
  CAS. Its update requires the expected status and `NOT EXISTS` lease, then
  accepts exactly one changed row.

Fix-round RED evidence:

```text
repository: 3 failed
- claimExecutionLease is not a function
- releaseExecutionLeaseOwner is not a function
- stopCaseWithoutExecutionLease is not a function

CaseRunner: 2 failed
- a tokenless fresh run resolved
- a second same-token runner resolved while the first owner was active

Worker: 2 failed
- a missing FORGE_RUNNER_TOKEN exited 0
- a token-bearing nonterminal run persisted no lease
```

Fix-round verification:

```text
focused: 5 files passed, 55 tests passed
full: 27 files passed, 229 tests passed
npm run check: exit 0
```

The focused tests include real Worker-thread claim and stop/acquire races, a
blocking FakePi run that observes owner PID and heartbeat while executing,
Worker process secret/lifecycle checks, and real CLI process coverage. The full
run retained only the pre-existing Windows symlink privilege skip note.

## Full Fix Round 2

The final review fix distinguishes recoverable JavaScript failures from hard
process death while preserving explicit transfer semantics.

- `CaseRunner` always clears its heartbeat timer and attempts an owner release
  in `finally`, including controlled exceptions and invalid resume-state
  transitions. The release remains conditional on the same token hash and PID,
  so a concurrent transfer cannot release another owner. Terminal cleanup has
  already deleted the lease, making the release a safe no-op.
- A hard crash still leaves a nonzero owner PID because process-level death
  cannot execute `finally`. A same-token runner with a different PID remains
  fail-closed. Explicit transfer, including same-token transfer, resets the
  owner to PID 0 and allows a new runner to claim it.
- Worker recovery does not steal an occupied lease. Claim failure returns a
  token-free actionable instruction to run `forge case transfer-lease` before
  retrying.

Fix-round RED:

```text
controlled run error: lease remained owned by PID 303
invalid human resume state: lease remained owned by PID 404
Worker recovery: owner claim failed without a case transfer-lease hint
```

Fix-round verification:

```text
focused: 3 files passed, 26 tests passed
full: 27 files passed, 233 tests passed
npm run check: exit 0
```
