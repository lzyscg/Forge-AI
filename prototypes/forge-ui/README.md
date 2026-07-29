# Forge AI 离线交互原型

这是一个独立、无网络依赖的 Forge AI 高保真静态原型，用于演示任务工作台、Agent 泳道运行工作区、完整会话和产物演进关系。

## 打开方式

在文件管理器中双击 `index.html`，使用 Chrome 或 Edge 直接通过 `file://` 打开。无需启动服务器、安装依赖或配置环境变量。

推荐使用 **1440×900** 的桌面视口查看完整运行工作区。页面也针对 1280×800、1024×768 和窄屏布局做了适配。

## 可交互演示路径

- 工作台 → 点击“雾港来信” → 直接进入任务运行工作区
- 左侧打开运行配置抽屉，查看模板、Agent、模型与 Provider 来源
- 中间查看 Agent 左右分列、时间从上向下推进的泳道流程图
- 点击 Turn → 打开该 Agent 的完整会话，并自动展开当前 Turn
- 在浮窗中依次查看完整输入、公开推理摘要、工具调用、完整输出和系统结果
- 关闭浮窗 → 回到原 Turn，并保持关联箭头与产物节点高亮
- 点击演进节点 → 同步选中关联 Turn
- 右侧产物抽屉 → 在正文、Diff、Issue、返修、验证和门禁之间查看关系
- 使用顶部中文搜索、状态筛选和紧凑列表
- 在已交付任务中打开复制结果、下载结果、基于此任务新建等终态入口，查看不产生真实副作用的原型说明
- 使用键盘 Tab 导航，按 `/` 聚焦搜索，按 Escape 关闭对话框

## 范围声明

页面中的全部数据、状态和命令均为模拟。原型不会创建 Case、写入数据库、调用模型或发起 HTTP(S) 请求。

浮窗中的“推理摘要”是模拟的公开决策说明，不是模型隐藏思维链。API Key、Token、Authorization Header 和 Provider 凭据不会进入页面。

该原型不修改 `apps/web`，也不属于 Forge AI P0 验收证据。它只用于视觉方向、信息架构和交互路径评审，不能证明真实 Worker、持久化、Pi 调用、交付门禁或崩溃恢复已经完成。

## 本地检查

在本目录运行：

```powershell
node state.test.mjs
node --check app.js
node --check mock-data.js
```

也可以从仓库根目录运行相同检查：

```powershell
node prototypes/forge-ui/state.test.mjs
node --check prototypes/forge-ui/app.js
node --check prototypes/forge-ui/mock-data.js
```
