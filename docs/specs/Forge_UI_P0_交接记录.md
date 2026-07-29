# Forge UI P0 交接记录

> 状态：`NOT_READY`
> 作用：这是开发 Agent 唯一可以当作外部授权和输入事实使用的交接记录。
> 安全：只记录非秘密信息。API Key、Token、Cookie、Authorization Header 和凭据文件内容不得写入本文。

## 1. 交接范围

```yaml
scope: Forge UI P0
includes:
  - local Web/BFF
  - Supervisor and isolated Case Worker
  - persistent commands, SQLite migrations and recovery
  - exact per-Agent Pi model binding
  - functional and visual P0 UI
  - Fake and real Pi release gates
excludes:
  - Forge UI P1 / complete Forge UI 1.0
  - predefined workflow orchestrator
  - Electron packaging
  - artifact editing
  - authentication, multi-user and remote deployment
```

本记录不能授权开发 Agent 宣称“整个 Forge 项目完成”。它只允许完成并验收 P0。P1、编排器和 Electron 需要后续独立 Spec、计划与 Harness。

## 2. 版本与 Git 授权

交接前由用户填写实际值：

```yaml
repository: C:/Users/13863/Desktop/zhihu/Forge AI/Forge-AI-main
spec_baseline_commit: NOT_SET
handoff_record_commit: CURRENT_HEAD
handoff_record_parent_must_equal_spec_baseline: true
target_branch: NOT_SET
worktree_must_be_clean: true
allow_create_codex_branch: NOT_SET
allow_task_commits: NOT_SET
allow_push: false
allow_pull_request: false
```

当前审查观察值，不等于交接授权：

```yaml
observed_branch: main
observed_head_before_handoff_docs: a26ab8e
observed_handoff_docs_committed: false
```

`spec_baseline_commit` 必须包含以下同一版本，并保留本记录的 `NOT_READY` 模板：

- `AGENTS.md`
- `CLAUDE.md`（历史基线警告版本，不是 P0 规范）
- `docs/Forge_UI_需求文档.md` 1.5
- `docs/Forge_UI_技术需求文档.md` 0.44
- `PLAN.md`
- `PLAN-REVIEW-LOG.md`
- `docs/superpowers/plans/2026-07-29-forge-ui-p0-implementation.md`
- `docs/specs/Forge_UI_P0_自主开发交接_Spec.md`
- `docs/specs/Forge_UI_P0_用户提供清单.md`
- 本记录

用户随后只修改本记录、把状态改为 `READY`，并可选加入一个仓库内视觉参考图；把这些输入提交为 `spec_baseline_commit` 的**直接子提交**。该子提交就是交接时的当前 `HEAD`，无需也禁止把它自己的 SHA 写回本文件，避免自指提交。相对 baseline 的允许变更只有：

- `docs/specs/Forge_UI_P0_交接记录.md`；
- 当 `reference_image_mode: repository_asset` 时，可增加一个 `docs/specs/assets/forge-ui-reference.png`、`.jpg`、`.jpeg` 或 `.webp`；不允许其他路径、外部绝对路径、URL 或第二张图片。

开发 Agent 开始前机械校验：

1. 当前 `HEAD^` 精确等于 `spec_baseline_commit`；
2. `git diff --name-only <spec_baseline_commit>..HEAD` 只命中上述允许路径；
3. 当前 `HEAD` 中本记录状态为 `READY`；
4. 工作树 clean。

如果 clone 无法解析 baseline、当前 HEAD 不是直接交接子提交、出现额外文件变更或工作树存在来源不明改动，状态按 `NOT_READY` 处理。

## 3. 本机与 Harness 权限

```yaml
windows_available: NOT_SET
node_version_gte_22_19: NOT_SET
npm_registry_access: NOT_SET
extra_disk_space_gib_gte_5: NOT_SET
allow_repository_p0_file_changes: NOT_SET
allow_npm_ci_and_builds: NOT_SET
allow_playwright_chromium_install: NOT_SET
allow_temp_data_and_release_roots: NOT_SET
allow_start_stop_registered_test_processes: NOT_SET
allow_terminate_unknown_processes: false
```

开发 Agent 只能终止 Harness 自己登记并能以实例身份证明的进程。PID 本身不是所有权证明。

## 4. Task 4 前的真实 Pi 条件

凭据必须已经由 Pi 或本机环境管理；本文只记录状态和非秘密标识。

```yaml
pi_auth_configured_locally: NOT_SET
provider_id: NOT_SET
model_id: NOT_SET
provider_network_available: NOT_SET
tool_calling_allowed: NOT_SET
real_pi_calls_authorized: NOT_SET
real_pi_cost_limit: NOT_SET
real_pi_time_window: NOT_SET
```

Task 4 用该选择完成目录、signature 和 in-memory Session 重建兼容性探针。Task 13 必须使用同一选择；更换 Provider/Model 会回到 Task 4。

## 5. 真实旧数据策略

必须且只能选择一项：

```yaml
real_legacy_data_strategy: NOT_SET
allowed_values:
  - no_real_migration_use_fixtures_and_fresh_root
  - migrate_production_under_strict_offline_protocol
  - migrate_test_under_strict_offline_protocol
  - preserve_old_root_wait_for_forensic_tool
```

推荐个人本地 P0 开发选择：

```yaml
real_legacy_data_strategy: no_real_migration_use_fixtures_and_fresh_root
```

除非用户实际确认，不得把推荐值当作已选择。检测到未知 Writer、未知 Schema、历史秘密、plaintext thinking 或空间不足时，自动迁移必须停止。

## 6. 视觉参考与最终签收

```yaml
visual_direction: warm restrained light editor
reference_image_mode: NOT_SET
reference_image_mode_allowed:
  - none_use_frozen_direction
  - repository_asset
reference_image_path: NOT_SET
reference_image_sha256: NOT_SET
reference_image_media_type: NOT_SET
reference_image_bytes: NOT_SET
final_visual_signoff_required: true
```

`none_use_frozen_direction` 时，path/hash/media type/bytes 均填 `NONE`，Task 14 只使用已冻结的文字视觉方向。

`repository_asset` 时，开始 Task 0 前必须同时证明：

- path 是上述唯一允许的仓库相对路径，文件由当前交接 `HEAD` 跟踪；
- 文件是普通文件，不是 symlink、junction 或其他 reparse point；
- 实际字节数满足 `1 byte <= reference_image_bytes <= 20 MiB`；
- magic bytes 与扩展名及 `image/png | image/jpeg | image/webp` 一致；
- `reference_image_sha256` 是文件实际 SHA-256，`reference_image_bytes` 是实际字节数；
- 当前 Agent 能在仓库内读取文件。Task 14 使用前再次核对 hash，任何漂移都停止而不静默改用外部文件。

外部“稳定路径”、下载目录、聊天附件 URL 或未哈希图片都不能使交接达到 `READY`。

自动 Gate 先产生 `G7_AUTOMATED_READY` 和一个精确 `release_id`。用户随后只对该 release 回答以下之一：

```text
接受当前视觉
```

或：

```text
需要一轮明确修改：
- 可观察问题 1
- 可观察问题 2
```

任何视觉修改都会产生新 commit 和新 `release_id`，并重新运行完整 G7；旧签收不能继承。

## 7. READY 判定

只有同时满足以下条件，才把文件顶部状态改为 `READY`：

- `spec_baseline_commit` 与 `target_branch` 已填写，当前 HEAD 满足上述直接子提交和允许路径规则，且 `allow_task_commits: true`；逐 Task clean-commit release 是本计划的机械前提，禁止 commit 时本次自主交接不能标记 READY；
- `allow_create_codex_branch` 已明确；若为 `false`，目标分支必须已经存在且明确允许在其上创建 Task commits；
- 交接 commit 可解析且包含全部冻结文档，交接工作树为 clean；
- Harness 权限全部明确；
- Task 4 的 Pi Provider/Model、网络、调用和费用边界明确；
- 真实旧数据策略已选择；
- `reference_image_mode` 为 `none_use_frozen_direction`，或仓库内图片通过路径/普通文件/magic bytes/大小/SHA-256/可读性检查；外部路径不得通过；
- `allow_push` 与 `allow_pull_request` 明确为 `true` 或 `false`，不得留空；
- 没有秘密进入本文。

`NOT_READY` 时，开发 Agent 只能做只读检查并列出缺项；不得开始 Task 0、修改文件、安装依赖、调用真实 Pi、迁移数据、commit 或 push。
