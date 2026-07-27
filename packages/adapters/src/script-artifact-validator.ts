import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
  ArtifactValidationRequest,
  ArtifactValidationResult,
  ArtifactValidatorPort,
} from '@forge-ai/contracts';

interface ValidatorResponse {
  valid: boolean;
  detail?: string;
  errors?: unknown[];
}

export class ScriptArtifactValidator implements ArtifactValidatorPort {
  private readonly scenarioRoot: string;

  constructor(scenarioRoot: string) {
    this.scenarioRoot = resolve(scenarioRoot);
  }

  validate(request: ArtifactValidationRequest): ArtifactValidationResult {
    const entrypoint = this.resolveEntrypoint(request.validator.entrypoint);
    const payload = JSON.stringify({
      schema_version: '1.0',
      artifact: {
        type: request.artifactType,
        content: request.artifactContent,
      },
      input: request.inputPayload,
    });
    const result = spawnSync(
      request.validator.command,
      [entrypoint, ...(request.validator.args ?? [])],
      {
        cwd: this.scenarioRoot,
        input: payload,
        encoding: 'utf8',
        shell: false,
        timeout: request.validator.timeout_ms ?? 10_000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      },
    );

    if (result.error) {
      throw new Error(result.error.message);
    }

    let response: ValidatorResponse;
    try {
      response = JSON.parse(result.stdout) as ValidatorResponse;
    } catch {
      const stderr = result.stderr.trim().slice(0, 2_000);
      throw new Error(
        `Validator ${request.validator.id} returned invalid JSON`
        + (stderr ? `: ${stderr}` : ''),
      );
    }
    if (typeof response.valid !== 'boolean') {
      throw new Error(`Validator ${request.validator.id} response is missing boolean "valid"`);
    }
    if (result.status !== 0 && response.valid) {
      throw new Error(
        `Validator ${request.validator.id} exited with code ${String(result.status)} after reporting success`,
      );
    }

    const errors = (response.errors ?? []).filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    );
    const detail = errors.join('; ')
      || response.detail?.trim()
      || (response.valid
        ? `Validator ${request.validator.id} passed`
        : `Validator ${request.validator.id} rejected the artifact`);
    return { passed: response.valid, detail };
  }

  private resolveEntrypoint(configuredPath: string): string {
    if (isAbsolute(configuredPath)) {
      throw new Error('Validator entrypoint must be inside the scenario directory');
    }
    const entrypoint = resolve(this.scenarioRoot, configuredPath);
    const relativePath = relative(this.scenarioRoot, entrypoint);
    if (
      relativePath === ''
      || relativePath.startsWith('..')
      || isAbsolute(relativePath)
    ) {
      throw new Error('Validator entrypoint must be inside the scenario directory');
    }
    if (!existsSync(entrypoint) || !statSync(entrypoint).isFile()) {
      throw new Error(`Validator entrypoint not found: ${configuredPath}`);
    }
    return entrypoint;
  }
}
