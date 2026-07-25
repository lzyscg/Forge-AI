/**
 * 基础 Adapter：时钟、ID 生成器、配置加载器
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { ClockPort, IdGeneratorPort, ConfigLoaderPort, ScenarioConfig } from '@forge-ai/contracts';

export class SystemClock implements ClockPort {
  now(): string {
    return new Date().toISOString();
  }
}

export class UuidGenerator implements IdGeneratorPort {
  generate(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }
}

export class FileConfigLoader implements ConfigLoaderPort {
  loadScenario(path: string): ScenarioConfig {
    const content = readFileSync(path, 'utf-8');
    return parseYaml(content) as ScenarioConfig;
  }

  loadPrompt(path: string): string {
    return readFileSync(path, 'utf-8');
  }
}
