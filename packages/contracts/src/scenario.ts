/**
 * 场景配置 Schema 类型（YAML 解析后的 TS 类型）
 * 铁律 1：平台代码不对任何业务角色名做分支判断，所有角色来自配置。
 */

export interface ScenarioConfig {
  scenario: {
    id: string;
    name: string;
    version: number;
  };
  input_fields: InputField[];
  agents: AgentConfig[];
  start_agent: string;
  routes: RouteConfig[];
  context_rules: Record<string, ContextRule>;
  artifact_types: ArtifactTypeConfig[];
  delivery: {
    deliverable_artifact_type: string;
  };
}

export interface InputField {
  key: string;
  label: string;
}

export interface AgentConfig {
  key: string;
  name: string;
  model: string;
  session: {
    policy: SessionPolicy;
  };
  prompt: string;
  skills: string[]; // MVP 保留字段，不解析不执行
  tools: string[];
}

export type SessionPolicy = 'persistent' | 'cold_per_version';

export interface RouteConfig {
  from: string;
  to: string[];
}

export interface ContextRule {
  include: string[];
}

export interface ArtifactTypeConfig {
  type: string;
  diff: 'line';
}
