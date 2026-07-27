# Task 3 Core Report

## Scope

Implemented the contracts, application, and SQLite repository core for
`ExecutionLease`. CLI wiring is intentionally excluded from this core step.

## Behavior

- Persists active leases in `execution_leases`; the credential column is only
  `runner_token_sha256`.
- Acquires a lease with one atomic SQLite `INSERT OR IGNORE`; two repository
  connections cannot both acquire the same Case.
- Validates, transfers, and heartbeats with conditional SQLite statements bound
  to the current token hash.
- Hashes all plaintext runner tokens in `CaseService` before calling the
  repository.
- Atomically authorizes abort, transitions the four allowed non-terminal states
  to `stopped`, records a hash-only idempotency authorization, and clears the
  active lease.
- Rejects abort for `approved` and `failed`; a repeated `stopped` abort succeeds
  only for the same token hash.
- Atomically clears the active lease on normal transitions to `approved`,
  `failed`, or `stopped`, while retaining it for `repairing`,
  `waiting_review`, and `waiting_human`.

## TDD Evidence

Initial RED:

```text
npx vitest run packages/adapters/src/execution-lease.test.ts
1 failed: first.acquireExecutionLease is not a function
```

Application RED:

```text
npx vitest run packages/application/src/execution-lease.test.ts
3 failed: service.acquireExecutionLease is not a function
```

Final focused GREEN:

```text
npx vitest run packages/adapters/src/execution-lease.test.ts packages/application/src/execution-lease.test.ts
2 files passed, 16 tests passed
```

Full regression and type check:

```text
npm test
26 files passed, 195 tests passed

npm run check
exit 0
```

The final race-focused suite passed three consecutive runs. The fix-round full
regression finished with 26 files and 208 tests passed.

The full test run emitted the repository's pre-existing Windows note that the
symlink escape test was skipped for insufficient privileges; there were no test
failures.

## Core Fix Round 1

Review fixes add two stronger atomicity boundaries:

- Fresh lease acquisition now includes `cases.status = 'created'` in the same
  `INSERT OR IGNORE ... SELECT` statement. Every other lifecycle state rejects
  new acquisition, while an existing non-terminal lease remains available for
  validate/resume and explicit transfer.
- Case state commits now use `compareAndSetCaseStatus` inside
  `BEGIN IMMEDIATE`. The update includes `WHERE case_id = ? AND status = ?`,
  optionally requires a matching lease hash, checks that exactly one row
  changed, and clears a terminal lease in that same transaction.
- `CaseService.transitionCaseStatus` accepts an optional plaintext runner token
  for callers that have completed token plumbing. The service hashes it before
  the CAS. Existing CaseRunner calls remain compatible without the optional
  argument; their expected-old-status CAS still prevents an abort winner from
  being overwritten.
- Two real Worker-thread connections are opened before a shared start barrier.
  Regression tests race acquire against acquire and authorized abort against a
  normal terminal transition. Exactly one contender commits in each race.

Fix-round RED evidence:

```text
8 acquisition tests failed: non-created Cases incorrectly acquired a lease
1 repository test failed: compareAndSetCaseStatus is not a function
1 application test failed: a supplied wrong token did not reject transition
```

Fix-round focused GREEN:

```text
npx vitest run packages/adapters/src/execution-lease.test.ts packages/application/src/execution-lease.test.ts
2 files passed, 29 tests passed

npm run check
exit 0
```
