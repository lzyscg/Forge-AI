import { parentPort, workerData } from 'node:worker_threads';
import type { CaseStatus, ExecutionLease } from '@forge-ai/contracts';
import { SqliteRepository } from './sqlite-repository.js';

type RaceOperation =
  | {
      kind: 'acquire';
      caseId: string;
      lease: ExecutionLease;
    }
  | {
      kind: 'abort';
      caseId: string;
      runnerTokenSha256: string;
      stoppedAt: string;
      abortableStatuses: CaseStatus[];
    }
  | {
      kind: 'transition';
      caseId: string;
      expectedStatus: CaseStatus;
      fields: Record<string, unknown>;
      runnerTokenSha256?: string;
      clearExecutionLease: boolean;
    };

const input = workerData as {
  dbPath: string;
  operation: RaceOperation;
};

const port = parentPort;
if (!port) {
  throw new Error('Execution lease race worker requires a parent port');
}

const repository = new SqliteRepository(input.dbPath);
port.postMessage({ type: 'ready' });
port.once('message', (message: { type: string }) => {
  if (message.type !== 'go') return;

  try {
    let outcome: unknown;
    if (input.operation.kind === 'acquire') {
      outcome = repository.acquireExecutionLease(
        input.operation.caseId,
        input.operation.lease,
      );
    } else if (input.operation.kind === 'abort') {
      outcome = repository.abortCaseWithExecutionLease(
        input.operation.caseId,
        input.operation.runnerTokenSha256,
        input.operation.stoppedAt,
        input.operation.abortableStatuses,
      );
    } else {
      outcome = repository.compareAndSetCaseStatus(
        input.operation.caseId,
        input.operation.expectedStatus,
        input.operation.fields,
        {
          runnerTokenSha256: input.operation.runnerTokenSha256,
          clearExecutionLease: input.operation.clearExecutionLease,
        },
      );
    }
    repository.close();
    port.postMessage({ type: 'result', outcome });
  } catch (error) {
    repository.close();
    port.postMessage({
      type: 'failure',
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
