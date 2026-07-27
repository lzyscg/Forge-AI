# Forge 返修指令关闭与 Case 恢复修复任务书

## 1. 文档用途

本文档用于指导开发 Agent 修复 Forge 内部的返修生命周期不一致和非终态 Case 静默退出问题。

本任务只修改 Forge 自身的领域层、应用层、持久化校验和测试，不修改外接故事编排器，也不加入任何故事业务逻辑。

目标不是让门禁变宽松，而是确保：

1. Issue、Revision Instruction、Artifact Version 和 Case 四套状态保持一致；
2. 已经被复审确认修复的返修指令能够全部关闭；
3. 非终态 Case 不会因为 Agent 没有工具调用而静默返回；
4. 再次执行 `forge case run <id>` 时能够从同一个 Case 的准确状态继续；
5. 非法或不存在的 `issue_ids` 不得进入数据库。

---

## 2. 真实复现

### 2.1 运行信息

- 日期：2026-07-26
- Scenario：`zhihu-story-outline`
- 模型：`deepseek/deepseek-v4-flash`
- Case ID：`case_42376dcd693f43a1`
- 数据库：`data/story-runs/gaokao-zero-real-003/forge.db`
- 输入故事：《高考0分后，我被清华录取了》
- 实际过程：11 个 Turn，发布 5 个大纲版本

### 2.2 最终表象

最终大纲版本已经满足以下条件：

- Artifact Version 状态为 `approved`；
- 所有 blocking Issue 均为 `verified`；
- 所有 Turn 均为 `completed`；
- 外接机械结构校验也能通过。

但 Forge 交付门禁失败：

```text
no_active_revision = false
存在 2 个未完成的返修指令：
ri_33f61daddd59401c(submitted)
ri_e6d8dc24fb9441ab(submitted)
```

Case 最终停在：

```text
status = repairing
completed_at = null
```

最后一轮 Agent 没有产生工具调用，`CaseRunner` 直接结束循环并返回了这个非终态 Case。

### 2.3 数据不一致证据

数据库中可观察到：

```text
issue_70224b0d670848f7 = verified
  ↳ 所属 ri_33f61daddd59401c = submitted

issue_4638ef0749ae416a = verified
issue_adce5a6b1cb8483b = verified
  ↳ 所属 ri_e6d8dc24fb9441ab = submitted
```

也就是说，Issue 已被复审标记为 `verified`，但承载这些 Issue 的 Revision Instruction 仍然处于会阻断交付的 `submitted`。

门禁失败后还观察到两个新建的 `issued` 指令，其 `issue_ids` 实际写入的是 Revision Instruction ID：

```text
["ri_33f61daddd59401c", "ri_e6d8dc24fb9441ab"]
```

这说明 `route_message` 当前接受任意字符串作为 `issue_ids`，没有验证：

- ID 是否对应真实 Issue；
- Issue 是否属于当前 Case；
- Issue 是否处于允许返修的状态。

---

## 3. 已定位的代码根因

### 3.1 审核通过时只关闭一条 submitted 指令

文件：

```text
packages/application/src/tool-executor.ts
```

当前实现：

```ts
const instructions = this.repo.getRevisionInstructionsByCase(caseId);
const submittedInstruction = instructions.find((ri) => ri.status === 'submitted');
```

随后只把这一条指令传给：

```ts
applyEvaluationVerify(...)
```

但同一段逻辑会把当前 Case 中所有 `claimed_fixed` Issue 都转成 `verified`。

因此当多轮返修产生多条 `submitted` 指令时，会出现：

```text
所有 claimed_fixed Issue → verified
只有第一条 submitted Instruction → verified
其余 Instruction 继续 submitted
```

这是本次真实故障的直接根因。

### 3.2 发布返修版本时隐式选择最后一条活跃指令

同一文件中存在：

```ts
const activeInstructions = this.repo.getActiveRevisionInstructions(caseId);
const ri = activeInstructions[activeInstructions.length - 1];
```

当数据库里已经存在多条活跃指令时，系统只处理最后一条，其他指令会继续悬挂。

这个“取最后一条”的隐式绑定既没有验证目标 Agent，也没有验证指令对应的 Artifact Version 或 Issue 集合。

### 3.3 route_message 不校验 issue_ids

文件：

```text
packages/application/src/tool-executor.ts
```

`routeMessage()` 在收到非空 `scope.issue_ids` 后直接创建 Revision Instruction。

即使 `repo.getIssue(issueId)` 返回空，也只是不产生 Issue 状态迁移；错误 ID 仍然会被持久化到 `revision_instructions.issue_ids`。

这会产生无法闭合、无法追溯的孤儿返修指令。

### 3.4 非终态 Case 在无工具调用时静默退出

文件：

```text
packages/application/src/case-runner.ts
```

当前逻辑：

```ts
if (result.toolCallResults.length === 0) {
  this.logger.info('[结束] Agent 未产生工具调用，循环结束');
  break;
}
```

它没有检查 Case 是否仍为：

- `running`
- `waiting_review`
- `repairing`

因此 `runCase()` 可以返回一个没有完成、没有失败、没有等待人工的 Case。

### 3.5 恢复消息信息不足

`buildResumeContextMessage()` 当前只告诉 Agent：

```text
活跃返修指令：N 条
```

没有给出：

- Revision Instruction ID；
- 当前状态；
- 关联 Issue ID；
- 目标 Artifact Version；
- 目标 Agent；
- 当前 Issue 状态；
- 下一步允许执行的动作。

恢复时 Agent 只能从数量猜测，容易再次错误调用 `route_message`。

---

## 4. 必须维持的系统不变量

修复后必须满足以下不变量。

### 4.1 引用完整性

Revision Instruction 中的每个 `issue_id` 必须：

- 对应真实存在的 Issue；
- 属于同一个 Case；
- 处于允许进入返修的状态；
- 不得是 Revision Instruction ID、Artifact ID 或任意自由文本。

### 4.2 审核一致性

当审核 Agent 对最新返修版本执行 `submit_evaluation(verdict=approve)` 时：

- 只验证与该版本和相关返修指令绑定的 `claimed_fixed` Issue；
- 每条被验证 Issue 所属的 `submitted` Revision Instruction 必须同时转为 `verified`；
- Issue 与 Instruction 的更新应在同一事务内完成；
- 不得出现 Issue 已 `verified`、Instruction 仍 `submitted` 的状态。

### 4.3 活跃指令一致性

不得依赖“数组最后一条”决定当前返修任务。

系统必须通过确定性字段关联：

- Case；
- Artifact；
- 目标 Artifact Version；
- 目标 Agent；
- Issue 集合。

如果业务规则要求同一 Artifact 同时最多只有一条活跃返修指令，应在创建时强制该约束；如果允许多条，则发布和审核逻辑必须逐条处理所有匹配指令。

### 4.4 Case 终态一致性

`runCase()` 返回时，Case 必须满足以下之一：

- `approved`
- `failed`
- `stopped`
- `waiting_human`

或者明确返回“仍在运行、需要继续调度”的结构化状态。

不得因为一次无工具调用而把 `repairing` Case 当作正常运行结束。

### 4.5 幂等性

以下操作重复执行不得产生重复状态迁移或重复指令：

- 重复提交同一个审核通过结果；
- 崩溃后重新运行同一 Case；
- 在 Artifact 已发布但 Instruction 尚未更新时恢复；
- 在 Instruction 已 verified 但 Case 尚未 approved 时恢复。

---

## 5. 推荐修改方案

## 5.1 P0：修复 submit_evaluation(approve)

不要再使用：

```ts
instructions.find((ri) => ri.status === 'submitted')
```

应执行：

1. 取得当前最新待审核 Artifact Version；
2. 找到与该版本相关的全部 `claimed_fixed` Issue；
3. 找到全部 `submitted` Revision Instruction；
4. 解析每条 Instruction 的 `issue_ids`；
5. 只选择其关联 Issue 已由当前版本声明修复、且当前均为 `claimed_fixed` 的 Instruction；
6. 在同一事务内：
   - Issue：`claimed_fixed → verified`
   - Instruction：`submitted → verified`
   - Artifact Version：`under_review → approved`
   - 写入 Issue Event 和必要的控制事件。

不要先把所有 `claimed_fixed` Issue 全部设为 `verified`，再尝试只关闭一条 Instruction。

如果存在无法匹配的 `submitted` Instruction，应让 `submit_evaluation` 返回结构化错误，不能批准 Artifact。

## 5.2 P0：修复 publish_artifact 的返修绑定

不能再无条件使用：

```ts
activeInstructions[activeInstructions.length - 1]
```

推荐优先采用“单活跃指令”约束：

- 同一个 Case、Artifact、目标 Agent 同时最多一条活跃 Revision Instruction；
- 新问题需要追加时，合并到现有活跃指令，或先终结旧指令再创建新指令；
- 发布返修版本时，根据当前 Agent、Artifact 和父版本确定唯一指令；
- 如果匹配到 0 条或多于 1 条，返回结构化错误，不发布模糊归属的返修版本。

如果产品决定允许多条并行返修指令，则需要：

- 对所有匹配指令分别做 scope 校验；
- 当前版本明确关联它所处理的所有 Instruction；
- 所有关联 Issue 和 Instruction 一起进入 `claimed_fixed/submitted`。

不要让模型负责计算或填写数据库 ID；关联仍应由系统根据当前上下文确定。

## 5.3 P0：为 route_message 增加外键和状态校验

在写入 Revision Instruction 前逐个验证 `issue_ids`：

```text
Issue 存在
AND issue.case_id === current case_id
AND issue.status IN (open, reopened)
```

如果任一 ID 不合法：

- 整个 `route_message` 返回 `success=false`；
- 不写入 Revision Instruction；
- 不写入部分 Issue 状态；
- 返回机器可读错误，例如：

```json
{
  "success": false,
  "error_code": "INVALID_ISSUE_REFERENCE",
  "invalid_issue_ids": ["ri_xxx"]
}
```

建议数据库层再增加防御：

- 将 `revision_instruction_issue` 拆为关联表并设置外键；或
- 保留 JSON 字段，但在 Repository 写入口统一执行校验。

若继续使用 JSON 字段，必须确保所有写入口都经过同一校验函数。

## 5.4 P0：处理非终态无工具调用

当 Agent 没有工具调用时先读取当前 Case 状态。

推荐策略：

1. Case 已是 `approved` 或 `waiting_human`：正常结束；
2. Case 仍是 `repairing`、`waiting_review` 或 `running`：
   - 第一次无工具调用：自动追加一次确定性纠错消息，明确当前待处理状态和允许工具；
   - 连续第二次仍无工具调用：Case 转为 `failed`，记录 `agent_no_action_in_nonterminal_state`；
3. 不允许直接 `break` 后保留非终态。

纠错消息不应让 Agent自行猜测 ID，应由系统列出准确的活跃 Instruction 和 Issue。

## 5.5 P1：增强同 Case 恢复上下文

修改 `buildResumeContextMessage()`，至少包含：

```text
Case 状态
最新 Artifact Version、状态和哈希
全部未关闭 Issue：ID、severity、status、anchor
全部活跃 Revision Instruction：
  ID
  status
  target_agent
  target_artifact_version_id
  issue_ids
下一步系统允许的动作
```

恢复决策应优先由程序判断：

- 最新版本为 `under_review`：路由审核 Agent；
- 存在 `issued/in_progress` 指令：路由指令的 `target_agent`；
- Issue 和 Instruction 已全部关闭但未交付：回到 start agent 申请交付；
- 状态无法归类：转 `failed` 或 `waiting_human`。

不要把完整状态判断全部交给模型。

## 5.6 P1：门禁失败后的确定性恢复

如果 `approve_delivery` 唯一失败项是 `no_active_revision`：

- 先检查这些 active Instruction 的关联 Issue；
- 若关联 Issue 已全部 `verified`，说明发生生命周期不一致，应由系统执行一致性修复或明确报内部错误；
- 不应让 start agent 根据门禁文本再次创建新的返修指令。

如果 active Instruction 仍有未验证 Issue，则根据其状态确定性路由：

- `issued/in_progress` → 返修 Agent；
- `submitted` → 审核 Agent。

---

## 6. 不接受的修复方式

以下方式不能作为本问题的最终修复：

- 从交付门禁中删除 `no_active_revision`；
- 把 `submitted` 从 active 状态中移除；
- 只修改故事大纲 Prompt；
- 在外接编排器中直接更新 Forge 数据库；
- 看到 Issue 已 verified 就无条件批量关闭所有 Instruction；
- Case 处于 `repairing` 时仍允许 `runCase()` 正常返回 success；
- 每次失败都创建一个新 Case 来绕过旧状态。

这些方式会隐藏状态不一致，而不是修复它。

---

## 7. 必须新增的自动化测试

## 7.1 多轮返修最终批准

构造：

- 3 条 `submitted` Revision Instruction；
- 每条关联不同的 `claimed_fixed` Issue；
- 同一个最新返修版本解决这些 Issue；
- 审核 verdict 为 `approve`。

断言：

- 所有关联 Issue 均为 `verified`；
- 3 条 Instruction 均为 `verified`；
- Artifact Version 为 `approved`；
- `no_active_revision` 通过。

此测试应能在当前代码上稳定失败。

## 7.2 部分指令不可验证

构造：

- 一条 Instruction 的 Issue 是 `claimed_fixed`；
- 另一条 Instruction 的 Issue 仍是 `repairing`。

断言：

- 审核批准不能产生半批准状态；
- Artifact 不得进入 `approved`；
- 返回可定位的结构化错误；
- 数据库状态保持一致。

## 7.3 非法 issue_ids

分别传入：

- 不存在的 ID；
- Revision Instruction ID；
- 其他 Case 的 Issue ID；
- 已 verified 的 Issue ID。

断言：

- `route_message` 返回失败；
- 不创建 Revision Instruction；
- 不改变任何 Issue 状态。

## 7.4 非终态无工具调用

构造 Case 状态为 `repairing`，Fake Pi 连续返回无工具调用。

断言：

- 第一次触发确定性纠错；
- 第二次转为 `failed` 或产品定义的明确阻塞终态；
- 不得以 `repairing` 状态静默返回。

## 7.5 同 Case 恢复

构造：

- Case 为 `repairing`；
- 存在一条 `submitted` Instruction；
- 最新 Artifact Version 为 `under_review`。

重新执行：

```powershell
forge case run <same-case-id>
```

断言：

- 不创建新 Case；
- 系统直接路由审核 Agent；
- 审核通过后关闭原 Instruction；
- Case 可以交付。

## 7.6 崩溃窗口幂等

至少覆盖：

1. Artifact Version 已写入、Issue 尚未更新时崩溃；
2. Issue 已 verified、Instruction 尚未 verified 时崩溃；
3. Instruction 已 verified、Case 尚未 approved 时崩溃。

断言恢复后：

- 不重复创建 Artifact Version；
- 不重复创建 Instruction；
- 状态最终一致；
- 事件记录可追溯。

## 7.7 真实形态回归

使用 Fake Pi 模拟：

```text
发布 v1
审核 repair
发布 v2
审核 repair
发布 v3
审核 approve
申请交付
```

断言最终：

```text
Case = approved
Artifact v3 = approved
所有 blocking Issue = verified
所有相关 Revision Instruction = verified
active revision count = 0
delivery gate = pass
```

---

## 8. 建议修改文件

主要修改范围：

```text
packages/application/src/tool-executor.ts
packages/application/src/case-runner.ts
packages/application/src/recovery.ts
packages/domain/src/state-transitions.ts
packages/domain/src/revision-instruction-state.ts
packages/adapters/src/sqlite-repository.ts
packages/contracts/src/tools.ts
```

建议新增或扩充测试：

```text
packages/application/src/issue-lifecycle.test.ts
packages/application/src/crash-recovery.test.ts
packages/application/src/idempotency.test.ts
packages/domain/src/delivery-gate.test.ts
```

如果增加数据库关联表，需要同步迁移 SQLite schema 和 Repository Port。

---

## 9. 开发完成后的验收命令

```powershell
npm test
npm run check
```

并重新执行同一类真实大纲 Case，验收以下结果：

```text
artifact_version_valid = true
artifact_version_approved = true
all_blocking_issues_verified = true
no_active_revision = true
no_incomplete_turns = true
Case status = approved
```

如果内容审核仍不通过，可以继续正常返修；但不得再出现：

```text
Issue 已 verified
Revision Instruction 仍 submitted
Case 静默停在 repairing
```

---

## 10. 完成定义

只有同时满足以下条件，才能认为本问题修复完成：

- 多轮返修后所有相关 Instruction 能完整关闭；
- Issue 与 Instruction 不再出现矛盾状态；
- 非法 `issue_ids` 无法入库；
- 非终态无工具调用会被明确处理；
- 同一个 Case 可以安全恢复；
- 门禁无需放宽即可通过；
- 新增测试在旧代码上失败、在新代码上通过；
- 现有全量测试和 TypeScript 检查继续通过。
