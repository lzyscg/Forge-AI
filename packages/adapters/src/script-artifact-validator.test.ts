import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScriptArtifactValidator } from './script-artifact-validator.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ScriptArtifactValidator', () => {
  it('passes Case input and candidate artifact over JSON stdin', () => {
    const scenarioRoot = mkdtempSync(join(tmpdir(), 'forge-validator-'));
    roots.push(scenarioRoot);
    const validatorsDir = join(scenarioRoot, 'validators');
    mkdirSync(validatorsDir);
    writeFileSync(
      join(validatorsDir, 'length.mjs'),
      [
        "let raw = '';",
        "for await (const chunk of process.stdin) raw += chunk;",
        'const request = JSON.parse(raw);',
        'const minimum = request.input.constraints.minimum;',
        'const actual = request.artifact.content.length;',
        'const valid = actual >= minimum;',
        'process.stdout.write(JSON.stringify({ valid, errors: valid ? [] : [`length ${actual} < ${minimum}`] }));',
        'process.exitCode = valid ? 0 : 2;',
      ].join('\n'),
      'utf8',
    );
    const validator = new ScriptArtifactValidator(scenarioRoot);

    const result = validator.validate({
      validator: {
        id: 'length',
        command: process.execPath,
        entrypoint: 'validators/length.mjs',
        timeout_ms: 5_000,
      },
      artifactType: 'draft',
      artifactContent: 'short',
      inputPayload: { constraints: { minimum: 10 } },
    });

    expect(result).toEqual({ passed: false, detail: 'length 5 < 10' });
  });

  it('rejects entrypoints outside the scenario directory', () => {
    const scenarioRoot = mkdtempSync(join(tmpdir(), 'forge-validator-'));
    roots.push(scenarioRoot);
    const validator = new ScriptArtifactValidator(scenarioRoot);

    expect(() => validator.validate({
      validator: {
        id: 'escape',
        command: process.execPath,
        entrypoint: '../outside.mjs',
      },
      artifactType: 'draft',
      artifactContent: 'content',
      inputPayload: {},
    })).toThrow(/inside the scenario directory/);
  });
});
