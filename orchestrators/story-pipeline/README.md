# Story Pipeline Orchestrator

这是 Forge AI 外部的多 Case 故事生产编排器。它不导入或修改 Forge 的 `packages/`、`apps/`，只通过公开 CLI 创建、运行和读取 Case。

当前实现的是原文复现链路：

```text
zhihu-story-outline
  -> (zhihu-chapter-packet
      -> zhihu-chapter-draft
      -> zhihu-story-ledger) x N
  -> zhihu-story-final
```

## 结构化产物

每个阶段同时保存三类结果：

- `raw-artifacts/`：Forge 已批准的模型原始产物，永久保留。
- `artifacts/`：通过外部机械门禁后才能产生的正式 Markdown。
- `structured/`：章节边界、章节单元、段落哈希、稳定状态 ID 等 JSON sidecar。

`manifest.json` 使用追加式记录，保存 Case、输入、模板、原始产物、正式产物、sidecar、校验报告的 SHA-256 和父记录 ID。模型不负责计算 ID 或哈希。

## 机械门禁

Forge 的模型审核通过后，外接编排器仍会执行 fail-closed 校验：

- 大纲：章节边界完整、全局区块完整、每章七个执行区块完整、事实带来源标签。
- 执行包：目标章节一致、功能单元字段完整、篇幅范围唯一、不得倒灌后文答案、不得复用原文长片段。
- 正文：标题唯一、篇幅在授权范围内、对白和高风险事实有执行包授权、不得复用原文长片段。
- 账本：稳定 ID、规定区块、证据可追溯、不得写入未来控制信息。
- 终稿：必须逐字等于编排器确定性拼接的冻结章节。

校验失败时仅保留原始产物和 `validation/` 报告，不生成正式产物，也不启动下游 Case。

## 运行

Fake Pi 端到端验收：

```powershell
npx tsx orchestrators/story-pipeline/src/index.ts run `
  --config orchestrators/story-pipeline/examples/imitation-one-chapter.json `
  --mode fake `
  --run-dir data/story-runs/demo
```

真实模型：

```powershell
$env:DEEPSEEK_API_KEY = "<your-key>"
$env:PI_MODEL_ID = "deepseek-v4-pro"
npx tsx orchestrators/story-pipeline/src/index.ts run `
  --config <production-config.json> `
  --mode real `
  --run-dir data/story-runs/<run-id>
```

配置中的 `source_file` 相对配置文件目录解析。正文 Case 只接收当前章节执行包，不接收完整原文或完整大纲。

## 下游失效传播

显式作废某个已交付阶段：

```powershell
npx tsx orchestrators/story-pipeline/src/index.ts invalidate `
  --run-dir data/story-runs/<run-id> `
  --from packet-b001 `
  --reason "执行包需要返修"
```

编排器按父记录依赖闭包追加失效记录。例如作废 `packet-b001` 会同时作废其 `draft-b001`、`ledger-b001` 和 `final`，但不会作废上游大纲。再次运行同一目录时，从最早失效节点产生新版本，旧记录与证据仍保留。

模板哈希、输入哈希或父版本变化也会自动触发同样的失效传播。

## 恢复与边界

使用同一个 `--run-dir` 重跑即可恢复。编排器先核对所有现存文件和哈希，再跳过仍有效的阶段。缺失、篡改或旧版 manifest 都会 fail closed。

当前机械校验负责可确定的结构、授权和血缘问题；人物力度、叙事张力、语言质量等仍由各 Case 的生成与审核 Agent 判断。首版按一章闭环实现，扩展到全文逐章生产时沿用相同记录协议。

## 安全对账与历史恢复

外接编排器只负责流程状态、身份、血缘、文件哈希和传输合同；故事内容是否合格由对应 Forge Case 的生成、审核和门禁负责。恢复流程不会重新判断故事质量，也不会因为 Case 较新就自动选择候选。

先执行零写入诊断：

```powershell
npx tsx orchestrators/story-pipeline/src/index.ts reconcile `
  --config <production-config.json> `
  --run-dir data/story-runs/<run-id> `
  --db data/story-runs/<run-id>/forge.db `
  --dry-run
```

同一 Stage 存在多个合格 Case 时，结果会列为 `ambiguous`，必须在 `--apply` 时用 `--adopt-case <case-id>` 显式选择。旧 Case 缺少新身份协议时，只能使用 `--attest-legacy-case-binding <case-id>:<stage-key>` 和 `--attestation-reason <reason>` 做精确声明；无法密码学复原的模板兼容性只能记录为 `operator_attested`，不得标记为 `verified`。

`reconcile --apply` 会在一次 Manifest CAS 中追加恢复记录、关闭悬空 Attempt 并接纳既有证据；它不删除历史 event、invalidation 或失败 Attempt。重复执行零动作时不会增加 Manifest revision。只有恢复动作明确需要继续运行原 Case 时才允许提供 `--mode fake|real`；纯诊断和既有产物接纳不会创建 Case 或调用模型。

替换已交付 Stage 使用两阶段 replacement：候选验证失败时旧记录仍有效；候选成功后，旧记录切换和下游失效传播在同一次 CAS 中提交。任何身份、输入、父版本、artifact、gate version 或文件哈希不一致都会 fail closed。
