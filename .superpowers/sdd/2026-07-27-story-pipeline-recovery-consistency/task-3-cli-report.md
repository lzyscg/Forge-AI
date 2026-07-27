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
