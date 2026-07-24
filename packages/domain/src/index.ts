/**
 * @forge-ai/domain — 核心业务规则（状态机、交付门禁、行级越界校验）
 * 铁律 5：绝不允许依赖数据库、Pi、Web 框架、进程环境。
 * domain 必须能在纯内存里被单元测试。
 */

export * from './case-state.js';
export * from './turn-state.js';
export * from './artifact-version-state.js';
export * from './issue-state.js';
export * from './revision-instruction-state.js';
export * from './state-transitions.js';
export * from './delivery-gate.js';
export * from './scope-validator.js';
