# Story Pipeline Orchestrator

这是 Forge AI 之外的多 Case 编排器。首版只实现 `imitation` 原文复现链路；
原创与改写需要独立的大纲模板，不能复用原文提取 Skill。编排器不导入或修改 Forge 的
`packages/`、`apps/`，只调用公开 CLI：

1. 用 `forge case create` 创建阶段 Case；
2. 用 `forge case run` 等待该 Case 通过自身审核与交付门禁；
3. 读取 `result.final_artifact.content`；
4. 通过 `FORGE_INPUT_FILE` 把已交付产物注入下一个 Case。

## 首版流水线

```text
zhihu-story-outline
  -> (zhihu-chapter-packet
      -> zhihu-chapter-draft
      -> zhihu-story-ledger) x N
  -> zhihu-story-final
```

每个 Forge Case 仍然只有一个正式交付物。跨 Case 的父子关系、输入哈希、
产物哈希和事件哈希链保存在运行目录的 `manifest.json`。

## Fake Pi 演示

```powershell
npx tsx orchestrators/story-pipeline/src/index.ts run `
  --config orchestrators/story-pipeline/examples/imitation-one-chapter.json `
  --mode fake `
  --run-dir data/story-runs/demo
```

Fake Pi 使用固定脚本，只验证 Case 接力、门禁、落盘和恢复机制，不代表故事质量。

确认五套模板的 Skill 能被 Pi Runtime 发现（零 Token）：

```powershell
npx tsx orchestrators/story-pipeline/src/skill-probe.ts
```

## 真实模型

```powershell
$env:DEEPSEEK_API_KEY = "<your-key>"
$env:PI_MODEL_ID = "deepseek-v4-pro"
npx tsx orchestrators/story-pipeline/src/index.ts run `
  --config <production-config.json> `
  --mode real `
  --run-dir data/story-runs/<run-id>
```

配置中的 `source_file` 相对于配置文件所在目录解析。正文只会收到当前章节执行包；
完整蓝图只进入章节包、账本和终审阶段。

## 恢复

使用同一个 `--run-dir` 重跑命令。编排器会校验已经交付产物的 SHA-256，
然后跳过已成功阶段，从第一个未完成阶段继续。若发现已有阶段记录但产物缺失或哈希
不一致，会 fail closed，不会覆盖证据。

## 边界

当前原型实现 Forge 门禁级接力和产物追踪，但尚未把各 Skill 自带的所有 Python
结构化控制器接入编排器。因此真实模型结果仍需在进入正式批量生产前补齐：

- 原文章节边界机械提取与验证；
- packet sidecar 与容量门禁；
- 正文逐段证据 sidecar；
- 状态账本增量 schema；
- 跨阶段回退后的下游失效传播。

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
