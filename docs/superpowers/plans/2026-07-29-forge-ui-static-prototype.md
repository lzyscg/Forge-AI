# Forge UI Static Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an offline, double-clickable Forge UI prototype that demonstrates the workbench, task overview, execution trace, and artifact evolution UX with mock data.

**Architecture:** Keep the prototype isolated under `prototypes/forge-ui/` and leave `apps/web` untouched. Use semantic HTML, token-driven CSS, classic browser scripts, a small pure state module, and data-driven mock records; all interactive state remains in memory and all rendering stays business-name agnostic.

**Tech Stack:** HTML5, CSS3, vanilla JavaScript, Node.js built-in test/assert/vm modules, local inline SVG icons, browser DevTools.

## Global Constraints

- Read and follow `docs/superpowers/specs/2026-07-29-forge-ui-static-prototype-design.md`.
- Before styling, read `C:/Users/13863/.codex/skills/ui-ux-pro-max/SKILL.md` and `references/quick-reference.md`; use its accessibility, interaction, layout, typography, animation, and navigation rules for the implementation and self-review.
- Do not modify `apps/web`, platform packages, database code, Pi integration, or existing requirements documents.
- The prototype must open from `file://` by double-clicking `index.html`; do not use ES modules, fetch, CDN resources, remote fonts, remote images, npm dependencies, or a local server.
- Keep story-specific names and content in `mock-data.js`; renderer and state logic must not branch on business role names.
- Use the approved warm editor palette, semantic tokens, large rounded surfaces, restrained motion, near-black primary actions, and Claude Design-inspired visual tone without copying its layout.
- Never display secrets, credentials, authorization headers, hidden reasoning, or a fake claim that a backend command succeeded.
- Use SVG icons with consistent 1.8px strokes; no emoji may serve as a structural icon.
- Normal text contrast must target at least 4.5:1; state cannot be communicated by color alone; keyboard focus must be visible.
- Supported validation viewports are 1440×900, 1280×800, and 1024×768. Below 760px, show a compact desktop recommendation without horizontal overflow.
- All new files must be UTF-8 and Chinese copy must render without mojibake.

---

### Task 1: Build and validate the complete offline prototype

**Files:**
- Create: `prototypes/forge-ui/index.html`
- Create: `prototypes/forge-ui/styles.css`
- Create: `prototypes/forge-ui/mock-data.js`
- Create: `prototypes/forge-ui/state.js`
- Create: `prototypes/forge-ui/app.js`
- Create: `prototypes/forge-ui/state.test.mjs`
- Create: `prototypes/forge-ui/README.md`

**Interfaces:**
- Consumes: `window.FORGE_MOCK_DATA` with `tasks`, `templates`, and `primaryTask` records from `mock-data.js`.
- Produces: `window.ForgePrototypeState` with pure functions `createInitialState`, `filterTasks`, `setView`, `selectTask`, `selectAgent`, `selectTimeline`, and `selectEvolution`.
- Produces: global browser renderer initialized by `app.js`, using `data-action`, `data-view`, and record IDs instead of inline event handlers.
- Produces: offline prototype opened through `prototypes/forge-ui/index.html`.

- [ ] **Step 1: Write the failing state behavior test**

Create `prototypes/forge-ui/state.test.mjs` with this complete behavior test:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'state.js'), 'utf8');
const context = { window: {} };
vm.createContext(context);
vm.runInContext(source, context);

const api = context.window.ForgePrototypeState;
const tasks = [
  { id: 'task-a', title: '雨夜故事', template: '短篇模板', phase: '正文写作', status: 'running' },
  { id: 'task-b', title: '旧城来信', template: '长篇模板', phase: '等待审核', status: 'waiting' },
];

assert.ok(api, 'state.js must expose window.ForgePrototypeState');

const initial = api.createInitialState({ tasks, primaryTask: { id: 'task-a' } });
assert.equal(initial.view, 'workbench');
assert.equal(initial.selectedTaskId, 'task-a');

assert.deepEqual(
  api.filterTasks(tasks, 'waiting', ''),
  [tasks[1]],
  'status filter must return only matching tasks',
);
assert.deepEqual(
  api.filterTasks(tasks, 'all', '正文'),
  [tasks[0]],
  'search must include task phase',
);

const overview = api.selectTask(initial, 'task-b');
assert.equal(overview.view, 'overview');
assert.equal(overview.selectedTaskId, 'task-b');

const selectedTurn = api.selectTimeline(overview, {
  id: 'turn-4',
  linkedEvolutionId: 'issue-1',
});
assert.equal(selectedTurn.selectedTimelineId, 'turn-4');
assert.equal(selectedTurn.selectedEvolutionId, 'issue-1');

const selectedVersion = api.selectEvolution(selectedTurn, {
  id: 'version-2',
  linkedTimelineId: 'turn-6',
});
assert.equal(selectedVersion.selectedEvolutionId, 'version-2');
assert.equal(selectedVersion.selectedTimelineId, 'turn-6');

console.log('Forge prototype state tests: 7 passed');
```

- [ ] **Step 2: Run the test and verify the expected RED result**

Run:

```powershell
node prototypes/forge-ui/state.test.mjs
```

Expected: FAIL because `prototypes/forge-ui/state.js` does not exist.

- [ ] **Step 3: Implement the pure state module**

Create `state.js` as a classic-script IIFE that assigns `window.ForgePrototypeState`. Implement:

```js
function createInitialState(data) {
  return {
    view: 'workbench',
    statusFilter: 'all',
    searchQuery: '',
    selectedTaskId: data.primaryTask.id,
    selectedAgentId: null,
    selectedTimelineId: null,
    selectedEvolutionId: null,
    artifactMode: 'content',
    compactTasks: false,
    toast: null,
  };
}
```

`filterTasks` must normalize with `String(value ?? '').toLocaleLowerCase('zh-CN')`, filter exact status unless `all`, and search `title`, `template`, and `phase`. Selection functions must return new state objects, preserve unrelated fields, and synchronize linked timeline/evolution IDs exactly as exercised by the test. `selectAgent` toggles the same agent off and always switches to `trace`; `setView` accepts only `workbench`, `templates`, `overview`, and `trace`, otherwise preserving the current view.

- [ ] **Step 4: Run the state test and verify GREEN**

Run:

```powershell
node prototypes/forge-ui/state.test.mjs
```

Expected: `Forge prototype state tests: 7 passed`.

- [ ] **Step 5: Create complete generic mock data**

Create `mock-data.js` as a classic script assigning `window.FORGE_MOCK_DATA`.

Required data:

- Six tasks with unique IDs and statuses `running`, `waiting`, `repairing`, `draft`, `failed`, and `delivered`.
- Three template cards for the shallow template-center view.
- One `primaryTask` containing four agents, 7 turns, 3 artifact versions, one blocking issue, one revision instruction, one verified event, and four delivery checks.
- Each Agent record contains `id`, `name`, `role`, `provider`, `model`, `modelSource`, `color`, and `status`.
- Each Turn contains `id`, `agentId`, `sequence`, `title`, `summary`, `time`, `status`, `kind`, and optional `linkedEvolutionId`.
- Each evolution node contains `id`, `type`, `title`, `summary`, `status`, `time`, and optional `linkedTimelineId`.
- Artifact v1 and v2 contain line arrays sufficient to display an actual before/after Diff; v3 is the current valid delivered version.
- All display IDs are friendly short labels rather than real-looking UUIDs.

The renderer may key on generic `type` and `status`, but never on specific Agent names or story titles.

- [ ] **Step 6: Build the semantic offline HTML shell**

Create `index.html` with:

- UTF-8, `lang="zh-CN"`, responsive viewport, descriptive title, and local stylesheet/scripts.
- Script order: `mock-data.js`, `state.js`, `app.js`, all classic scripts with `defer`.
- Skip link to `#main-content`.
- Outer terracotta canvas, warm-white rounded application shell, header, sidebar navigation, and `main`.
- Header controls for search, production/test environment, and a mock “新建生产任务” action.
- Two labeled navigation buttons: 工作台 and 模板中心.
- Empty containers with stable IDs `view-title`, `view-toolbar`, and `view-content`.
- One `aria-live="polite"` toast region and an accessible modal/dialog shell for prototype-only action explanations.
- Inline SVG symbol sprite or repeated inline SVG icons using one outline style; no Unicode emoji icons.
- `<noscript>` explaining that the static interactive prototype needs JavaScript.

Do not put story-specific markup in HTML.

- [ ] **Step 7: Implement the approved visual system**

Create `styles.css` using the exact base tokens from the design spec and extend them with spacing, radius, shadow, motion, and z-index tokens.

Required visual behavior:

- Terracotta page canvas framing a large `#F3F0EA` shell; surfaces use `#FFFDF9`.
- 26px shell radius, 16–20px card radii, fine warm borders, low-contrast shadow.
- Near-black primary CTA and restrained coral active state.
- System/Noto Sans SC UI stack; serif stack only for artifact reading content.
- Sidebar active item uses icon, label, contrast, and a shape—not color alone.
- Task status badges always show readable Chinese text and a small icon/shape.
- Workbench summary cards are calm filters, not oversized KPI cards.
- Trace view uses CSS grid for agent rail, main timeline, and evolution chain.
- Selected Agent, Turn, and evolution nodes use synchronized outlines/backgrounds without layout shift.
- Diff uses side-by-side or stacked before/after rows, with `+`/`−` markers and text labels.
- Buttons, nav, task rows, and chain nodes have pointer, hover, active, and `:focus-visible` states.
- Dialog uses a 40–50% dark scrim and Escape-close affordance.
- Motion uses opacity/transform only, 160–240ms, and is removed or reduced under `prefers-reduced-motion`.
- At 1024px the layout remains usable; below 1100px the evolution rail moves below the timeline; below 760px the sidebar collapses and a desktop recommendation banner appears with no horizontal overflow.

- [ ] **Step 8: Implement generic rendering and interactions**

Create `app.js` as a classic-script IIFE. Obtain `data` and `stateApi` from `window`, create initial state, and render into the stable containers.

Implement focused functions:

```js
renderApp()
renderShellState()
renderWorkbench()
renderTemplates()
renderOverview(task)
renderTrace(task)
renderTaskRows(tasks)
renderAgentRail(agents)
renderTimeline(turns)
renderEvolution(nodes)
renderArtifactPanel(task)
renderDiff(beforeLines, afterLines)
showPrototypeNotice(title, body)
closeDialog()
```

Use event delegation on `document` for `data-action` elements. Required actions:

- Switch workbench/templates navigation.
- Update search and status filters.
- Toggle compact task rows.
- Open the primary task overview from a task row.
- Open execution trace from overview and return predictably.
- Select/toggle an Agent and dim unrelated turns.
- Select a Turn and synchronize the linked evolution node.
- Select an evolution node and synchronize the linked Turn.
- Toggle artifact content/Diff.
- Open the model detail disclosure.
- Show a non-blocking prototype dialog for new task, pause, stop, retry, and model-change locations without claiming success.
- Close dialog through close button, scrim click, and Escape.

After view changes, move focus to the view `<h1>` using `tabindex="-1"`; preserve workbench search/filter state when returning. Do not use `innerHTML` with user-provided values; mock content may be escaped through a small `escapeHtml` helper before template insertion.

- [ ] **Step 9: Add usage and scope documentation**

Create `README.md` containing:

- Double-click instructions for `index.html`.
- Recommended Chrome/Edge viewport of 1440×900.
- A list of interactive demo paths.
- Explicit statement that all data and commands are simulated.
- Explicit statement that the prototype does not modify `apps/web` and is not P0 evidence.
- Commands `node state.test.mjs`, `node --check app.js`, and `node --check mock-data.js`.

- [ ] **Step 10: Run static and state verification**

Run:

```powershell
node prototypes/forge-ui/state.test.mjs
node --check prototypes/forge-ui/state.js
node --check prototypes/forge-ui/mock-data.js
node --check prototypes/forge-ui/app.js
git diff --check
npm run check
```

Expected: all commands exit 0; state test reports 7 passed; TypeScript check reports no error.

- [ ] **Step 11: Perform browser self-review**

Open `prototypes/forge-ui/index.html` in Chrome or Edge and verify:

- Workbench → overview → trace → overview → workbench path.
- Status filtering and Chinese search.
- Agent → Turn → evolution and evolution → Turn synchronization.
- Content/Diff switch, model disclosure, prototype dialog, Escape close.
- Keyboard Tab order and visible focus.
- 1440×900, 1280×800, and 1024×768 screenshots or documented observations.
- Browser console has zero errors and Network shows no HTTP(S) request.
- No mojibake, emoji structural icons, unexpected horizontal scroll, or content hidden behind sticky UI.
- Reduced-motion emulation removes nonessential animation.

Read `C:/Users/13863/.codex/skills/ui-ux-pro-max/references/quick-reference.md` again for a final accessibility, interaction, layout, typography, animation, and navigation pass. Fix any violation before proceeding.

- [ ] **Step 12: Commit the independently verified prototype**

Run:

```powershell
git add -- prototypes/forge-ui
git commit -m "feat: 添加 Forge UI 静态交互原型" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push origin main
```

The report must name the commit, every verification command and its exit result, browser viewport observations, any remaining concern, and confirm that only `prototypes/forge-ui/` changed.
