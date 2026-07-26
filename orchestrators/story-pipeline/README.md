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
