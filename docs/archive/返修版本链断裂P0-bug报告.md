# BUG：返修版本链断裂导致 publish_artifact 永久阻塞

## 严重级别

P0 — 阻断生产链路（draft 阶段无法完成多轮返修）

## 触发条件

任何多 Agent 场景（如 `zhihu-chapter-draft`：chapter-writer + chapter-auditor）中，只要返修循环超过一轮且中间发生过以下任一情况，就会触发：

- Writer 发布时触发 scope_violation（越界），系统自动重发 RI
- Auditor 在 Writer 已发布新版本后追加 Issue 并合并到现有 RI

不需要真实模型即可复现——用单元测试构造内存 Repository 即可（见「验证方法」节）。

## 现象

Draft Case 经过多轮审核返修后，Writer Agent 无法发布修复版本，报错：

```
无法发布返修版本：当前没有匹配 Agent(chapter-writer)与父版本(av_710d052178c84cd1)的活跃返修指令。
活跃指令: ri_b4e08c8d7f284b59(chapter-writer->av_f584747894714fbe)
```

Agent 被迫调用 `request_human_input`，Case 进入 `waiting_human` 终态。

## 数据库现场（典型状态快照）

```
活跃返修指令: ri_xxx
  target_agent = chapter-writer
  target_artifact_version_id = av_aaa (v1, status=superseded)
  status = issued 或 in_progress

当前最新产物版本: av_ccc (v3, status=under_review)
```

RI 绑定的 target_version(v1) 已被 superseded，但 RI 本身仍活跃。Writer 尝试 publish_artifact(parent=v3) 时，因 v1 ≠ v3 被拒绝。

## 根因分析

### 问题代码位置

`packages/application/src/tool-executor.ts` 第 148-166 行：

```typescript
if (activeInstructions.length > 0 && parentVersion) {
  const parentId = parentVersion.artifact_version_id as string;
  const candidates = activeInstructions.filter((ri) => {
    if (ri.status === 'submitted') return false;
    if (ri.target_agent !== ctx.agentKey) return false;
    const targetVersion = ri.target_artifact_version_id as string | null;
    // ★ 问题在这里：要求 target_version === parentId 精确匹配
    return targetVersion === parentId || targetVersion === null;
  });
  if (candidates.length === 0) {
    return { success: false, error: `无法发布返修版本...`, error_code: 'NO_ACTIVE_INSTRUCTION' };
  }
}
```

### 断裂链路（最可能的触发路径）

```
1. Writer 发布 v1 (初始版本)
2. Auditor 审查 v1 → 开 Issue → route_message 创建 RI:
     target_artifact_version_id = v1 (当时最新)
     status = issued
3. Writer 按 RI 修复 → publish_artifact(parent=v1) → 匹配成功
   → 但如果 scope 校验失败（越界）：
     - 该版本 status=rejected
     - RI 状态 → scope_violation
     - 系统自动重发 RI（第 208-219 行）：
       target_artifact_version_id = 旧 RI 的 target = v1 ← ★ 复制了过时的 target
4. Writer 再次发布（可能换了策略），这次通过了 → v2 published
5. Auditor 审查 v2 → 开新 Issue → route_message:
   - 如果找到 existingActive（issued/in_progress）→ 合并 issue_ids
     但 不更新 target_artifact_version_id ← ★ 合并时遗漏
   - 如果没找到 → 新建 RI，target = latestVersion = v2（正常）
6. 某种路径下 v3 被发布（可能是第二个 Agent 或无 RI 的 draft 发布）
7. Writer 尝试发布 v4(parent=v3):
   - RI.target_version = v1 ≠ v3 → NO_ACTIVE_INSTRUCTION → 永久阻塞
```

### 两个缺陷点

**缺陷 1：scope_violation 重发 RI 时复制过时的 target_artifact_version_id**

位置：第 212 行
```typescript
target_artifact_version_id: (ri.target_artifact_version_id as string | null) ?? null,
```
应该用当前最新产物版本，而不是旧 RI 的 target。

**缺陷 2：route_message 合并到现有 RI 时不更新 target_artifact_version_id**

位置：第 542-546 行
```typescript
this.repo.updateRevisionInstruction(existingActive.revision_instruction_id as string, {
  issue_ids: JSON.stringify(mergedIssueIds),
  editable_anchors: JSON.stringify(mergedEditable),
  frozen_anchors: JSON.stringify(mergedFrozen),
  // ★ 缺少: target_artifact_version_id: latestVersion
});
```

**缺陷 3（设计层面）：publish_artifact 匹配条件过于严格**

当 RI 的 target_version 已被 superseded（不再是最新版本），但 RI 仍然活跃（issued/in_progress）且 target_agent 匹配时，应该视为合法匹配，而不是拒绝。

## 修复方案

### 方案 A（推荐）：放宽 publish_artifact 匹配 + 自动更新 RI target

在第 148-158 行的匹配逻辑中：

```typescript
const candidates = activeInstructions.filter((ri) => {
  if (ri.status === 'submitted') return false;
  if (ri.target_agent !== ctx.agentKey) return false;
  const targetVersion = ri.target_artifact_version_id as string | null;
  // 修复：target 为 null、精确匹配、或 target 版本已被 superseded（过时）均视为匹配
  if (targetVersion === null) return true;
  if (targetVersion === parentId) return true;
  // target 版本已不是最新 → 指令过时但仍有效，允许匹配
  const targetVer = this.repo.getArtifactVersion(targetVersion);
  if (targetVer && targetVer.status === 'superseded') return true;
  return false;
});
```

匹配成功后，自动将 RI 的 target_artifact_version_id 更新为当前 parent：

```typescript
// 在 boundInstruction 确定后（第 175 行之后）
if ((boundInstruction.target_artifact_version_id as string) !== parentId) {
  this.repo.updateRevisionInstruction(boundInstruction.revision_instruction_id as string, {
    target_artifact_version_id: parentId,
  });
}
```

### 方案 B（补丁）：修复两个遗漏点

1. 第 212 行 scope_violation 重发时，查询当前最新版本：
```typescript
const latestVer = this.repo.getLatestVersion(artifactId);
target_artifact_version_id: latestVer?.artifact_version_id ?? null,
```

2. 第 542 行合并时，同步更新 target：
```typescript
const latestVer = /* 查询当前最新产物版本 */;
this.repo.updateRevisionInstruction(existingActive.revision_instruction_id as string, {
  issue_ids: JSON.stringify(mergedIssueIds),
  editable_anchors: JSON.stringify(mergedEditable),
  frozen_anchors: JSON.stringify(mergedFrozen),
  target_artifact_version_id: latestVer?.artifact_version_id ?? existingActive.target_artifact_version_id,
});
```

### 建议

方案 A + B 同时实施。A 解决"已经断裂后如何恢复"，B 解决"如何预防断裂"。

## 验证方法

### 1. 单元测试（必须）

在 `tests/` 下新增或扩展 tool-executor 相关测试文件，用内存 Repository 构造以下场景：

```typescript
// 伪代码：最小复现
const repo = new InMemoryRepository();
// 1) 创建 Case + Artifact + v1(under_review)
// 2) 创建 RI: target_agent='writer', target_artifact_version_id=v1, status='issued'
// 3) 将 v1 标记为 superseded，创建 v2(under_review), v3(under_review)
//    模拟 artifact.current_valid_version_id = v3
// 4) Writer 调用 publish_artifact({ content, parent=v3 })
// 期望：修复前返回 NO_ACTIVE_INSTRUCTION；修复后返回 success=true
```

运行命令：`npx vitest run` （项目根目录，配置在 `vitest.config.ts`）

### 2. 集成测试（推荐）

构造一个会触发 scope_violation 的完整 Case 流程（Fake Pi 模式即可）：
- Writer 第一次发布越界 → RI 进 scope_violation → 系统重发 RI
- Writer 第二次发布成功 → v2
- Auditor 追加 Issue → route_message 合并
- Writer 第三次发布 → 验证不阻塞

运行命令：`PI_MODE=fake FORGE_RUNNER_TOKEN=test npx vitest run --config vitest.integration.config.ts`

### 3. 编译验证

修改后确保 `npm run check`（tsc --noEmit）零错误。

## 约束提醒

- 铁律 4（一切追加绝不覆盖）：RI 的 target 更新应以 control_event 追加记录
- 铁律 3（交付是系统的决定）：放宽匹配不能影响 approve_delivery 门禁的独立性
- 不能引入新的 AMBIGUOUS 情况：如果有多条 RI 的 target 都是 superseded，仍需拒绝

## 相关文件

| 文件 | 作用 |
|------|------|
| `packages/application/src/tool-executor.ts` | publish_artifact + route_message 逻辑（主修复点） |
| `packages/application/src/revision-consistency.ts` | 孤儿 RI 清理（可能需要扩展） |
| `packages/domain/src/state-transitions.ts` | RI 状态机转换规则 |
| `packages/application/src/case-runner.ts` | 续跑时的 RI 上下文注入 |
