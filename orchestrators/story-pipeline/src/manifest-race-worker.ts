import { existsSync, writeFileSync } from 'node:fs';
import {
  appendManifestEvent,
  initializeManifest,
  saveManifestCas,
  type PipelineManifestV21,
} from './manifest.js';

const [mode, manifestPath, worker, readyPath, gatePath] = process.argv.slice(2);
if (!mode || !manifestPath || !worker || !readyPath || !gatePath) {
  throw new Error('manifest race worker arguments are incomplete');
}

function emptyManifest(): PipelineManifestV21 {
  return {
    schema_version: '2.1',
    revision: 0,
    previous_manifest_sha256: null,
    run_id: 'run-1',
    story_id: 'story-1',
    title: `worker-${worker}`,
    mode: 'imitation',
    config_sha256: 'config-hash',
    boundary_map_path: 'structured/boundaries.json',
    boundary_map_sha256: 'boundary-hash',
    created_at: '2026-07-27T00:00:00.000Z',
    updated_at: '2026-07-27T00:00:00.000Z',
    stages: [],
    attempts: [],
    invalidations: [],
    reinstatements: [],
    replacements: [],
    events: [],
    final_artifact_path: null,
  };
}

writeFileSync(readyPath, 'ready', 'utf8');
while (!existsSync(gatePath)) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

if (mode === 'initialize') {
  const result = initializeManifest(manifestPath, emptyManifest);
  process.stdout.write(JSON.stringify({
    worker,
    status: result.created ? 'created' : 'reloaded',
  }));
} else if (mode === 'cas') {
  try {
    saveManifestCas(manifestPath, 0, (latest) => {
      appendManifestEvent(latest, {
        at: '2026-07-27T00:00:01.000Z',
        type: 'attempt_outcome_changed',
        stage_key: 'stage-1',
        attempt_id: `attempt-${worker}`,
        before_outcome: 'running',
        after_outcome: 'interrupted',
        case_id: `case-${worker}`,
        artifact_id: null,
        artifact_version: null,
        version_id: null,
        record_id: null,
        reason: `worker ${worker}`,
        actor: 'story-pipeline',
      });
    });
    process.stdout.write(JSON.stringify({ worker, status: 'committed' }));
  } catch (error) {
    if (!(error instanceof Error) || !/revision conflict/i.test(error.message)) throw error;
    process.stdout.write(JSON.stringify({ worker, status: 'conflict' }));
  }
} else {
  throw new Error(`unsupported race mode: ${mode}`);
}
