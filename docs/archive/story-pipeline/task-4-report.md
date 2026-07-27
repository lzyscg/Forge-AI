# Task 4 Report: Cancellable asynchronous Forge client

## Scope

- Added `ForgeCliClient` with asynchronous direct invocation of
  `process.execPath --import tsx/esm apps/cli/src/index.ts`.
- Added bounded JSONL stdout parsing and bounded stderr capture.
- Added Windows exact-PID `taskkill.exe /PID <pid> /T /F` cancellation and
  POSIX detached process-group cancellation.
- Cancellation waits for the run process to exit, calls `case abort` with the
  same runner token, then returns the reconciled `case status` snapshot.
- Converted `executeStage`, `runPipeline`, and `main` to async. Top-level
  `SIGINT`/`SIGTERM` handlers only abort an `AbortController`.
- Wired Task 2's immutable `run/story/stage/chapter` create flags.
- Wired Task 1's restricted credential file. Plaintext is read immediately
  before CLI invocation and is redacted from errors. Forge-confirmed terminal
  outcomes clear the credential; an unknown local interruption retains it for
  explicit recovery.

No quality validator or content responsibility changed.

## RED evidence

Initial fake-child contract:

```text
npx vitest run orchestrators/story-pipeline/src/forge-client.test.ts
1 failed suite / 0 tests
Failed to load ./forge-client.js
```

Cancellation ordering contract after the minimal create/run implementation:

```text
npx vitest run orchestrators/story-pipeline/src/forge-client.test.ts
3 tests: 1 failed, 2 passed
AbortSignal rejected with AbortError instead of resolving the post-abort
status snapshot
```

The Windows integration fixture also caught two test-harness races before
GREEN: an already-finished fast FakePi process could not be inspected, and a
temporary scenario whose `scenario.id` still named the repository template did
not restore the intended slow validator. The final fixture uses an immutable
absolute scenario identity and a real blocking validator child.

## GREEN evidence

Focused unit and Windows/FakePi integration:

```text
npx vitest run orchestrators/story-pipeline/src/forge-client.test.ts
1 file passed, 6 tests passed
```

The integration observes both the real CLI wrapper PID and validator child PID.
After cancellation, the returned snapshot and SQLite Case are `stopped`, the
execution lease is absent, both PIDs are absent, `apps/cli/bin.js` was not used,
and the plaintext token is absent from SQLite and the Case log.

Full regression:

```text
npm test
28 files passed, 239 tests passed
```

Type check:

```text
npm run check
exit 0
```

The only full-suite note was the pre-existing Windows symlink-security skip for
insufficient privileges.

## Risks and deferred work

- A local command failure whose Forge status is unknown remains `interrupted`
  and retains its credential. Deleting it would make same-token recovery
  impossible; Task 6 reconciliation owns the final projection.
- The child output limits default to 1 MiB per stream. Exceeding either limit
  terminates the exact process tree and returns a token-free error.
- Forge runner tokens remain required CLI arguments by the Task 3 lease
  protocol. They are never placed in manifest events, diagnostics, snapshots,
  logs, or thrown errors by this client.

## Fix round 1

Reviewer follow-up hardened four boundaries:

- Every protocol value produced while a runner token is known is recursively
  sanitized, including strings nested in objects and arrays. This applies to
  successful run snapshots, command-failure parsed results, and post-abort
  status snapshots.
- Process-tree termination has separate configurable taskkill and child-close
  bounds. Windows requires taskkill exit code zero and observed child close;
  POSIX requires observed child close after process-group kill. Timeout,
  nonzero, and no-op taskkill paths fail token-free and never proceed to Forge
  abort/status.
- A cancelled create recovers a Case ID already emitted by the killed child.
  The pipeline persists its Attempt, event, and restricted credential before
  recording an already-requested cancellation as `interrupted`. A create with
  no committed ID still returns `AbortError`.
- `SIGINT` and `SIGTERM` use persistent idempotent listeners until `main`
  cleanup, so a second signal cannot restore Node's default termination while
  reconciliation is still running.

Fix-round RED:

```text
npx vitest run orchestrators/story-pipeline/src/forge-client.test.ts
13 tests: 8 failed, 5 passed
```

The failures independently covered two nested token leaks, three unbounded or
unverified taskkill modes, committed create cancellation returning AbortError,
and missing persistent SIGINT/SIGTERM handlers.

Fix-round focused GREEN:

```text
npx vitest run orchestrators/story-pipeline/src/forge-client.test.ts
1 file passed, 14 tests passed

npm run check
exit 0
```

The Windows/FakePi wrapper-and-validator process-tree integration remains part
of the focused suite.

Fix-round full regression:

```text
npm test
28 files passed, 247 tests passed
```
