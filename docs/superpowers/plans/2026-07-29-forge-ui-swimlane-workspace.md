# Forge UI Swimlane Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the prototype's overview-to-trace drill-down with a task-first swimlane workspace containing a collapsed configuration drawer, an expanded artifact drawer, and a read-only Agent conversation inspector.

**Architecture:** Keep the prototype dependency-free and usable through `file://`. Extend the existing mock data and pure state module first, then replace only the task detail renderer with a three-part workspace. SVG paths connect immutable mock nodes; the conversation inspector uses the existing native dialog pattern and never exposes hidden chain-of-thought or secrets.

**Tech Stack:** Static HTML, CSS, browser JavaScript, SVG, Node.js assertion tests.

## Global Constraints

- Modify only `prototypes/forge-ui/` plus this implementation plan.
- Keep the prototype fully offline: no package, CDN, font, HTTP(S), fetch, WebSocket, database, Pi, or filesystem runtime calls.
- Clicking a task opens the task workspace directly; no overview interstitial remains in the primary path.
- Agent lanes are vertical columns arranged left to right; time flows from top to bottom.
- The left configuration drawer is collapsed by default; the right artifact drawer is expanded by default.
- Clicking a Turn opens a read-only Agent conversation dialog, positions the selected Turn, expands it, and keeps other Turns collapsed.
- Show only public reasoning summaries. Never label or persist hidden model chain-of-thought, API keys, tokens, authorization headers, or provider credentials.
- Keep all task controls simulated and state-legal. The prototype must not claim a real operation succeeded.

---

### Task 1: Workspace state and mock execution graph

**Files:**
- Modify: `prototypes/forge-ui/state.js`
- Modify: `prototypes/forge-ui/state.test.mjs`
- Modify: `prototypes/forge-ui/mock-data.js`

**Interfaces:**
- Produces: `selectTask(state, taskId)` opening `view: "workspace"`.
- Produces: `toggleConfigDrawer(state)`, `toggleArtifactDrawer(state)`, `openTurnInspector(state, turnId)`, and `closeTurnInspector(state)`.
- Produces: state fields `configDrawerOpen`, `artifactDrawerOpen`, and `inspectorTurnId`.
- Produces: each primary-task Turn with `input`, `reasoningSummary`, `toolCalls`, `output`, `systemEvents`, and graph routing identifiers.

- [ ] **Step 1: Write failing state tests**

Add assertions equivalent to:

```js
const workspace = api.selectTask(initial, 'task-b');
assert.equal(workspace.view, 'workspace');
assert.equal(workspace.configDrawerOpen, false);
assert.equal(workspace.artifactDrawerOpen, true);

const configOpen = api.toggleConfigDrawer(workspace);
assert.equal(configOpen.configDrawerOpen, true);

const inspectorOpen = api.openTurnInspector(configOpen, 'turn-4');
assert.equal(inspectorOpen.inspectorTurnId, 'turn-4');

const inspectorClosed = api.closeTurnInspector(inspectorOpen);
assert.equal(inspectorClosed.inspectorTurnId, null);
```

- [ ] **Step 2: Run the state test and confirm RED**

Run:

```powershell
node prototypes/forge-ui/state.test.mjs
```

Expected: failure because the workspace state functions and fields do not exist.

- [ ] **Step 3: Implement the pure state transitions**

Add `"workspace"` to the allowed views, initialize both drawer fields and `inspectorTurnId`, make `selectTask` enter the workspace, and expose the four pure transition functions.

- [ ] **Step 4: Expand the primary mock task**

For every Turn, add complete but compact mock fields:

```js
{
  input: {
    text: '完整业务输入文本',
    attachments: [{ id: 'version-1', label: '正文 v1', kind: 'artifact' }]
  },
  reasoningSummary: '这是公开的决策摘要，不是隐藏思维链。',
  toolCalls: [
    {
      id: 'tool-1',
      name: '读取产物',
      status: 'completed',
      duration: '0.8s',
      arguments: '{ "version": "v1" }',
      result: '已读取正文 v1'
    }
  ],
  output: { text: '完整模型输出文本' },
  systemEvents: ['保存产物版本 v2'],
  graph: {
    inputFrom: 'turn-3-output',
    outputNodeId: 'turn-4-output'
  }
}
```

Use only story-neutral platform concepts in renderer logic; story-specific content remains mock data.

- [ ] **Step 5: Run the state test and confirm GREEN**

Run:

```powershell
node prototypes/forge-ui/state.test.mjs
```

Expected: all assertions pass.

---

### Task 2: Three-part task workspace and vertical swimlane graph

**Files:**
- Modify: `prototypes/forge-ui/app.js`
- Modify: `prototypes/forge-ui/styles.css`
- Modify: `prototypes/forge-ui/index.html`

**Interfaces:**
- Consumes: Task 1 workspace fields and Turn graph data.
- Produces: `renderWorkspace(task)`, `renderConfigDrawer(task)`, `renderSwimlaneCanvas(task)`, `renderArtifactDrawer(task)`, and `renderTurnInspector(task, turn)`.
- Produces: event actions `toggle-config-drawer`, `toggle-artifact-drawer`, `open-turn-inspector`, and `close-turn-inspector`.

- [ ] **Step 1: Route task selection directly to the workspace**

Remove the overview interstitial from the primary task-selection path. Keep workbench and template-center navigation unchanged. The workspace header must compactly show task title, template, status, phase, latest event, and only state-legal actions.

- [ ] **Step 2: Render the two contextual drawers**

The left drawer contains template, scenario, Agent/model mapping, provider source, and runtime parameters. It is collapsed by default and opens without covering the wide-screen graph.

The right drawer contains the existing artifact content/Diff switch, evolution chain, Issues, repairs, verification, and delivery gate. It is expanded by default. On narrow desktop widths both drawers become overlays.

- [ ] **Step 3: Render vertical Agent lanes**

Render one CSS-grid column per Agent with a sticky lane header. Time advances downward. Place input, Turn, output/artifact, and system nodes at deterministic rows derived from mock Turn order.

Use an SVG overlay with `marker-end` arrows:

- vertical solid paths for continuity inside one Agent lane;
- curved cross-lane paths for routed input, artifact, Issue, repair, and verification handoffs;
- highlighted paths for the currently selected Turn or evolution node.

Do not render a separate Agent table or separate Turn table.

- [ ] **Step 4: Add graph interactions**

Clicking a Turn selects it, highlights related paths and artifact nodes, and opens the conversation inspector. Clicking an artifact/evolution node performs the inverse selection. Preserve the existing content/Diff interaction in the right drawer.

- [ ] **Step 5: Implement responsive behavior**

At wide desktop widths, show the collapsed left rail, full graph, and expanded right drawer. At laptop widths, make both drawers overlay panels. Keep lane headers readable, allow horizontal graph scrolling when Agent lanes exceed the canvas, and retain the existing mobile advisory.

---

### Task 3: Agent conversation inspector, documentation, and verification

**Files:**
- Modify: `prototypes/forge-ui/app.js`
- Modify: `prototypes/forge-ui/styles.css`
- Modify: `prototypes/forge-ui/index.html`
- Modify: `prototypes/forge-ui/README.md`

**Interfaces:**
- Consumes: Task 1 Turn conversation fields and Task 2 node selection.
- Produces: a native modal dialog with full Agent session context and the selected Turn expanded.

- [ ] **Step 1: Build the read-only conversation dialog**

Use a native `<dialog>` separate from the existing prototype-notice dialog. The header shows Agent, role, model, provider, Turn number, status, time, and duration.

Render all Turns for the selected Agent in chronological order. The selected Turn is expanded; other Turns use `<details>`. Within the expanded Turn, render:

1. complete sanitized business input and attachment cards;
2. a clearly labelled `推理摘要` block;
3. tool-call cards in exact sequence, each with sanitized arguments, result, status, and duration;
4. complete model output;
5. system persistence and routing events.

- [ ] **Step 2: Preserve context when closing**

Close through the button, backdrop click, or Escape. Return focus to the originating Turn node and preserve graph scrolling, selection, highlighted routes, and drawer state.

- [ ] **Step 3: Update prototype documentation**

Update `prototypes/forge-ui/README.md` so the primary walkthrough is:

```text
工作台 → 点击任务 → 任务运行工作区 → 查看 Agent 纵向泳道
→ 点击 Turn → 查看完整 Agent 会话 → 关闭浮窗 → 查看右侧产物链
```

Retain the explicit statement that all data and operations are simulated and are not P0 evidence.

- [ ] **Step 4: Run focused verification**

Run:

```powershell
node prototypes/forge-ui/state.test.mjs
node --check prototypes/forge-ui/state.js
node --check prototypes/forge-ui/mock-data.js
node --check prototypes/forge-ui/app.js
git diff --check
npm run check
```

Expected: every command exits with code 0.

- [ ] **Step 5: Perform visual interaction QA**

Open `prototypes/forge-ui/index.html` through `file://` in Chrome or Edge and verify:

- task click opens the workspace directly;
- left drawer defaults closed and can open/close;
- right drawer defaults open and can open/close;
- four Agent lanes are arranged left to right and time reads top to bottom;
- arrows clearly connect cross-Agent handoffs;
- a Turn click opens the correct Agent session and selected Turn;
- input, reasoning summary, tools, output, and system events are readable;
- no hidden-thought wording, credential-like strings, console errors, or HTTP(S) requests appear;
- layouts remain usable at 1440×900, 1280×800, 1024×768, and 390×844.

- [ ] **Step 6: Commit**

```powershell
git add -- prototypes/forge-ui docs/superpowers/plans/2026-07-29-forge-ui-swimlane-workspace.md
git commit -m "feat: 重构 Forge UI Agent 泳道工作区" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push origin main
```
