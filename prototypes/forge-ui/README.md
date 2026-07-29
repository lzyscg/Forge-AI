# Forge AI 离线交互原型

这是一个独立、无网络依赖的 Forge AI 高保真静态原型，用于演示任务工作台、任务总览、执行轨迹和产物演进关系。

## 打开方式

在文件管理器中双击 `index.html`，使用 Chrome 或 Edge 直接通过 `file://` 打开。无需启动服务器、安装依赖或配置环境变量。

推荐使用 **1440×900** 的桌面视口查看完整三栏执行轨迹。页面也针对 1280×800、1024×768 和窄屏布局做了适配。

## 可交互演示路径

- 工作台 → 点击“雾港来信” → 任务总览 → 查看执行轨迹
- 执行轨迹 → 选择 / 取消执行角色 → 观察无关 Turn 降低强调
- 点击 Turn → 同步选中关联演进节点
- 点击演进节点 → 同步选中关联 Turn
- 任务总览或执行轨迹 → 在“正文 / Diff”间切换
- 任务总览 → 展开角色“模型详情” → 模拟切换模型
- 使用顶部中文搜索、状态筛选和紧凑列表
- 打开新建、暂停、停止、重试等入口，查看不产生真实副作用的原型说明
- 使用键盘 Tab 导航，按 `/` 聚焦搜索，按 Escape 关闭对话框

## 范围声明

页面中的全部数据、状态和命令均为模拟。原型不会创建 Case、写入数据库、调用模型或发起 HTTP(S) 请求。

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
