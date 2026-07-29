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

assert.deepEqual(
  Array.from(api.getTaskActions('delivered')),
  ['copy-result', 'download-result', 'new-from-task'],
  'delivered tasks must expose only read-only or follow-up actions',
);
assert.deepEqual(
  Array.from(api.getTaskActions('running')),
  ['pause', 'stop'],
  'running tasks must expose only running-state controls',
);
assert.deepEqual(
  Array.from(api.getTaskActions('failed')),
  ['retry'],
  'failed tasks may retry but cannot be stopped again',
);
assert.deepEqual(
  Array.from(api.getTaskActions('unknown')),
  [],
  'unknown task statuses must fail closed with no actions',
);

console.log('Forge prototype state tests: 11 passed');
