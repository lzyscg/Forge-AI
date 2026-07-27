/**
 * 场景配置 Schema 类型（YAML 解析后的 TS 类型）
 * 铁律 1：平台代码不对任何业务角色名做分支判断，所有角色来自配置。
 *
 * 使用 typebox 定义 JSON Schema，TS 类型由 Static<> 派生（single source of truth）。
 */

import { Type, type Static } from 'typebox';
import { Check, Errors } from 'typebox/value';

// ─── Sub-schemas ───────────────────────────────────────────────────────────────

export const InputFieldSchema = Type.Object({
  key: Type.String(),
  label: Type.String(),
});

export const SessionPolicySchema = Type.Union([
  Type.Literal('persistent'),
  Type.Literal('cold_per_version'),
]);

export const AgentConfigSchema = Type.Object({
  key: Type.String(),
  name: Type.String(),
  model: Type.String(),
  session: Type.Object({
    policy: SessionPolicySchema,
  }),
  prompt: Type.String(),
  skills: Type.Array(Type.String()),
  tools: Type.Array(Type.String()),
});

export const RouteConfigSchema = Type.Object({
  from: Type.String(),
  to: Type.Array(Type.String()),
});

export const ContextRuleSchema = Type.Object({
  include: Type.Array(Type.String()),
});

export const ArtifactTypeConfigSchema = Type.Object({
  type: Type.String(),
  diff: Type.Literal('line'),
});

export const DeliveryValidatorConfigSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  command: Type.String({ minLength: 1 }),
  entrypoint: Type.String({ minLength: 1 }),
  args: Type.Optional(Type.Array(Type.String())),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 300_000 })),
});

// ─── Root Schema ───────────────────────────────────────────────────────────────

export const ScenarioSchema = Type.Object({
  scenario: Type.Object({
    id: Type.String(),
    name: Type.String(),
    version: Type.Number(),
  }),
  input_fields: Type.Array(InputFieldSchema),
  agents: Type.Array(AgentConfigSchema),
  start_agent: Type.String(),
  routes: Type.Array(RouteConfigSchema),
  context_rules: Type.Record(Type.String(), ContextRuleSchema),
  artifact_types: Type.Array(ArtifactTypeConfigSchema),
  delivery: Type.Object({
    deliverable_artifact_type: Type.String(),
    validators: Type.Optional(Type.Array(DeliveryValidatorConfigSchema)),
  }),
});

// ─── Derived Types (single source of truth) ────────────────────────────────────

export type ScenarioConfig = Static<typeof ScenarioSchema>;
export type InputField = Static<typeof InputFieldSchema>;
export type AgentConfig = Static<typeof AgentConfigSchema>;
export type SessionPolicy = Static<typeof SessionPolicySchema>;
export type RouteConfig = Static<typeof RouteConfigSchema>;
export type ContextRule = Static<typeof ContextRuleSchema>;
export type ArtifactTypeConfig = Static<typeof ArtifactTypeConfigSchema>;
export type DeliveryValidatorConfig = Static<typeof DeliveryValidatorConfigSchema>;

// ─── Runtime Validation ────────────────────────────────────────────────────────

/**
 * 运行时校验：检查传入对象是否符合 ScenarioSchema。
 * 通过则返回类型安全的 ScenarioConfig，失败则抛出详细错误。
 */
export function validateScenario(config: unknown): ScenarioConfig {
  if (Check(ScenarioSchema, config)) {
    return config;
  }
  const errors = Errors(ScenarioSchema, config);
  const messages = errors.map(
    (e) => `  [${e.instancePath || '/'}] ${e.message}`,
  );
  throw new Error(
    `ScenarioConfig validation failed:\n${messages.join('\n')}`,
  );
}
