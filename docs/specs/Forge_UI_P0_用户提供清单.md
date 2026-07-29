# Forge UI P0 用户提供清单（模板）

> 状态：空白模板，不构成任何授权。所有未填写或未勾选项一律视为“未提供/不允许”。
> 用途：帮助用户填写 `docs/specs/Forge_UI_P0_交接记录.md`，再把项目交给没有历史上下文的开发 Agent。
> 原则：没有列在“必须提供”中的技术设计，不需要用户判断。本模板本身永远不标记 `READY`。

## A. 交接前必须提供

### A1. 正确的仓库版本

- [ ] 开发 Agent 能访问完整 Forge AI 仓库。
- [ ] 仓库中包含以下冻结文档：
  - `AGENTS.md`
  - `CLAUDE.md`（仅用于保留历史基线警告，不是 P0 规范）
  - `docs/specs/Forge_UI_P0_自主开发交接_Spec.md`
  - `docs/specs/Forge_UI_P0_用户提供清单.md`
  - `docs/specs/Forge_UI_P0_交接记录.md`
  - `docs/Forge_UI_需求文档.md` 1.5
  - `docs/Forge_UI_技术需求文档.md` 0.44
  - `PLAN.md`
  - `PLAN-REVIEW-LOG.md`
  - `docs/superpowers/plans/2026-07-29-forge-ui-p0-implementation.md`
- [ ] 如果开发 Agent 使用另一个 clone、worktree 或任务，先提交或同步上述文档修改，避免只拿到旧计划。
- [ ] 先把所有冻结文档和仍为 `NOT_READY` 的交接记录提交为 `spec_baseline_commit`，再把该完整 SHA 填入交接记录。
- [ ] 填完交接记录并改为 `READY` 后，只提交该记录和可选的 `docs/specs/assets/forge-ui-reference.*`，形成 baseline 的直接子提交；不要把子提交自身 SHA 写回文件。
- [ ] 交给开发 Agent 时让该子提交保持为当前 `HEAD`，并确保工作树 clean。
- [ ] 告诉开发 Agent 目标分支、是否允许创建 feature branch，并明确允许按 Task 创建本地 commit；本 P0 发布协议依赖 clean commit，若不允许 commit 就不能进行自主闭环交接。

推荐授权：

```text
允许创建 codex/ 前缀分支；允许每个 Task 独立 commit；未经明确要求不 push、不创建 PR。
```

### A2. 本机执行权限

- [ ] 允许开发 Agent在仓库内创建、修改和删除本次 P0 范围内的文件。
- [ ] 允许运行 `npm ci`、Vitest、TypeScript、Next build、Playwright、本地进程故障测试和打包脚本。
- [ ] 允许创建仅位于临时目录或明确测试数据根中的 SQLite、日志、release 和浏览器测试数据。
- [ ] 允许启动和终止 Harness 自己创建的 Supervisor/Worker/Next 测试进程。
- [ ] 不允许 Harness 终止无法证明由它启动的未知系统进程。

### A3. 基础运行环境

- [ ] Windows 开发环境可用。
- [ ] Node.js 版本为 `>=22.19.0`。
- [ ] npm 与 `npm ci` 可用。
- [ ] 可以访问 npm registry。
- [ ] 有足够磁盘空间用于依赖、多个临时 SQLite generation、Next standalone 和 release 副本。

建议至少预留：

- 仓库和依赖之外额外 `5 GiB` 开发空间；
- 实际迁移时另满足 `2 × 旧数据库大小 + 512 MiB`。

## B. 开始开发时不需要提供

以下内容不需要在 Task 0 前提供：

- 不需要把真实 API Key 发给 Agent。
- 不需要真实生产数据库。
- 不需要实际用户故事或业务正文。
- 不需要手工设计数据库 Schema。
- 不需要选择 Turn Journal 状态。
- 不需要决定 SQLite 事务边界。
- 不需要逐 Task 批准技术实现。
- 不需要 Electron 配置。
- 不需要鉴权、账号或权限方案。
- 不需要人工为 Fake Pi 测试修改 Case 状态。

Task 0–3 可以只使用合成 fixture 和隔离测试数据库；Task 4 开始前必须满足下一节的真实 Pi 外部条件，才能让 G2 和后续流程无中断闭环。

## C. Task 4 前必须提供的真实 Pi 外部条件

这部分必须在 Task 4 开始前准备，不应通过聊天发送秘密值。Task 13 必须复用 Task 4 已通过兼容性探针的同一 Provider/Model；临时换模型会重新打开 Task 4。

### C1. Pi 认证

- [ ] 在本机 Pi 中完成至少一个 Provider 的认证或 API Key 配置。
- [ ] 凭据只保存在 Pi 支持的位置或运行环境中。
- [ ] 不把 API Key、Token、Authorization Header、Cookie 或凭据文件内容发给开发 Agent。
- [ ] 确认开发 Agent只需要读取 Pi 返回的“已配置/可用”状态。

### C2. 发布验收模型

- [ ] 指定或确认一个用于发布门禁的 Provider ID。
- [ ] 指定或确认一个用于发布门禁的 Model ID。
- [ ] 如果 Pi 目录还未扫描完成，允许开发 Agent先列出候选，再让你进行一次选择。
- [ ] 所选模型允许工具调用，并能完成最小非业务内容测试。
- [ ] 所选模型通过 Task 4 的实际 signature/Session 重建兼容性探针后，才能继续 Task 13。

待填写：

```text
Provider ID：
Model ID：
```

### C3. 网络与费用授权

- [ ] 本机网络可以访问对应 Provider。
- [ ] 允许 Task 4 和 Task 13 执行有限次数真实模型调用。
- [ ] 确认可接受的测试费用上限。
- [ ] 如果达到费用上限，Harness 必须停止真实调用并保留此前证据。

待填写：

```text
真实 Pi 测试费用上限：
允许的测试时间窗口：
```

推荐默认：

```text
只运行实施计划规定的最小真实 Pi 探针和三项发布故障门禁，不做自然语言质量评测。
```

## D. 真实旧数据迁移时才需要提供

如果本轮只开发软件，可以整节保持未勾选，Harness 使用全新临时数据根。

### D1. 迁移目标

- [ ] 明确是否要迁移真实旧数据。

选择一项：

- [ ] 不迁移真实旧数据，只验证 fixture 和全新数据根。
- [ ] 迁移真实 production 数据。
- [ ] 迁移真实 test 数据。

### D2. 严格离线选择

如果迁移真实旧数据：

- [ ] 关闭所有由你启动的旧 Forge、Worker、CLI 和 Web 实例。
- [ ] 不在迁移过程中启动旧版本 Forge。
- [ ] 同意 Harness 只确认自己登记的进程，不声称扫描并证明任意未知进程不存在。
- [ ] 如果数据根来源不明或静默状态无法确认，从下列方案中选择一项。

选择一项：

- [ ] 重启电脑后，在启动任何 Forge 进程前迁移。
- [ ] 使用全新数据根，旧数据保持只读归档。
- [ ] 暂不迁移，等待未来 forensic migration。

### D3. 数据安全异常

如果扫描发现历史凭据、Header、Cookie 或 plaintext thinking：

- [ ] 同意自动迁移立即停止。
- [ ] 同意 Harness 不修改旧证据来“清洗后继续”。
- [ ] 从“全新数据根”或“未来 forensic migration”中选择。

禁止提供：

- 不要要求开发 Agent手工修改 SQLite 行；
- 不要要求开发 Agent修改 Pi JSONL；
- 不要要求开发 Agent伪造 migration checksum；
- 不要要求开发 Agent覆盖旧产物或事件。

## E. 最终视觉确认时需要提供

Task 0–13 不需要持续视觉反馈。Task 14 对一个 clean-commit immutable release 完成全部客观门禁后，只需要一次整体确认。该确认只接受或拒绝主观视觉，不替代功能、安全、恢复或无障碍测试。

- [ ] 确认视觉方向继续采用暖色编辑器、奶油色表面、炭黑文字和珊瑚色强调。
- [ ] 确认桌面优先，不要求手机适配。
- [ ] 确认 1440/1920 应充分利用宽屏，不保留大面积无意义侧边空白。
- [ ] 确认左侧为运行配置抽屉，右侧为产物/版本/Issue/返修链。
- [ ] 确认中间主体为 Agent 横向分泳道、时间纵向推进的流程。
- [ ] 确认 Turn 完整过程使用单独 Agent 会话浮窗。
- [ ] 在交接记录中二选一：写 `none_use_frozen_direction`，或把唯一参考图复制为 `docs/specs/assets/forge-ui-reference.png|jpg|jpeg|webp`；不使用外部绝对路径、URL 或下载目录。
- [ ] 如果使用仓库内参考图，填写实际 SHA-256、MIME/type 和字节数，并确认它是当前交接 HEAD 跟踪的普通文件、不是 symlink/junction/reparse point，且满足 `1 byte <= reference_image_bytes <= 20 MiB`。

视觉参考路径（如果使用）：

```text
reference_image_mode：
仓库内参考图路径或 NONE：
SHA-256 或 NONE：
media type 或 NONE：
bytes 或 NONE：
```

最终只需回答：

```text
接受当前视觉 / 需要一轮明确修改
```

如果需要修改，应描述可观察的问题，例如“工作区仍过窄”“右侧栏遮挡泳道”，不要重新打开已经冻结的技术架构。

## F. 产品运行期的人工作业

这些不是开发阻塞项，但实际使用 Forge 时由内容生产操作者完成：

- [ ] 回答 `waiting_human` 请求。
- [ ] 查看 `outcome_unknown` 证据后选择安全恢复或停止。
- [ ] 根据 Issue/返修链继续正常内容生产。
- [ ] 查看系统门禁结果；不手工伪造 verified 或 delivered。

自动测试会使用 fixture 模拟这些动作，不需要你在测试运行时在线等待。

## G. 推荐的一次性交接消息

把下面内容和仓库一起交给开发 Agent：

```text
请实现 Forge UI P0。

先完整阅读 AGENTS.md，以及：
- docs/specs/Forge_UI_P0_交接记录.md
- docs/specs/Forge_UI_P0_自主开发交接_Spec.md
- docs/specs/Forge_UI_P0_用户提供清单.md
- docs/Forge_UI_需求文档.md
- docs/Forge_UI_技术需求文档.md
- PLAN.md
- docs/superpowers/plans/2026-07-29-forge-ui-p0-implementation.md
- PLAN-REVIEW-LOG.md

先机械校验交接记录为 READY、其中 commit 可解析且工作树干净；否则只列缺项并停止。通过后从 Task 0 开始，严格按 Gate 推进。普通技术问题和测试失败自行解决；只有交接 Spec 第 9 节允许的外部条件或协议级阻塞才询问我。

所有 Provider/Model、费用、真实数据策略和 Git 权限都只以交接记录为准，不从本消息推断。

Task 0–14、G0–G7、Fake/真实 Pi/进程恢复门禁全部有同一发布物的运行证据时，状态最多为 G7_AUTOMATED_READY；我接受该 exact release 的视觉结果后，才可声明 Forge UI P0_ACCEPTED。不得声明 P1、编排器或整个 Forge 项目完成。
```

## H. 最小用户介入总结

如果采用推荐的“全新测试数据根”方式，你实际只需提供：

1. 可访问的正确仓库版本；
2. 允许 Agent运行本地开发、测试、打包和它自己创建的进程；
3. Task 4 前在 Pi 中配置并确认一个 Provider/Model；
4. 一次真实调用费用授权；
5. Task 14 后一次视觉确认。

除此之外，不需要逐 Task 人工判断技术方案。
