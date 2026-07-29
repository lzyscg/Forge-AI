(function exposeForgePrototypeState(global) {
  'use strict';

  const allowedViews = new Set(['workbench', 'templates', 'overview', 'trace']);
  const taskActionsByStatus = {
    running: ['pause', 'stop'],
    waiting: ['stop'],
    repairing: ['pause', 'stop'],
    draft: ['new-from-task'],
    failed: ['retry'],
    delivered: ['copy-result', 'download-result', 'new-from-task'],
  };

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

  function normalize(value) {
    return String(value ?? '').toLocaleLowerCase('zh-CN');
  }

  function filterTasks(tasks, statusFilter, searchQuery) {
    const normalizedQuery = normalize(searchQuery).trim();

    return tasks.filter((task) => {
      const matchesStatus = statusFilter === 'all' || task.status === statusFilter;
      const searchableText = [task.title, task.template, task.phase].map(normalize).join(' ');
      return matchesStatus && (!normalizedQuery || searchableText.includes(normalizedQuery));
    });
  }

  function setView(state, view) {
    return {
      ...state,
      view: allowedViews.has(view) ? view : state.view,
    };
  }

  function selectTask(state, taskId) {
    return {
      ...state,
      view: 'overview',
      selectedTaskId: taskId,
      selectedAgentId: null,
      selectedTimelineId: null,
      selectedEvolutionId: null,
      artifactMode: 'content',
    };
  }

  function selectAgent(state, agentId) {
    return {
      ...state,
      view: 'trace',
      selectedAgentId: state.selectedAgentId === agentId ? null : agentId,
    };
  }

  function selectTimeline(state, turn) {
    return {
      ...state,
      selectedTimelineId: turn.id,
      selectedEvolutionId: turn.linkedEvolutionId ?? null,
    };
  }

  function selectEvolution(state, evolution) {
    return {
      ...state,
      selectedEvolutionId: evolution.id,
      selectedTimelineId: evolution.linkedTimelineId ?? null,
    };
  }

  function getTaskActions(status) {
    return [...(taskActionsByStatus[status] ?? [])];
  }

  global.ForgePrototypeState = {
    createInitialState,
    filterTasks,
    setView,
    selectTask,
    selectAgent,
    selectTimeline,
    selectEvolution,
    getTaskActions,
  };
})(window);
