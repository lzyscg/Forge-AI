(function initializeForgePrototype(global, document) {
  'use strict';

  const data = global.FORGE_MOCK_DATA;
  const stateApi = global.ForgePrototypeState;

  if (!data || !stateApi) {
    throw new Error('Forge prototype data and state modules must load before app.js');
  }

  const elements = {
    viewTitle: document.getElementById('view-title'),
    viewToolbar: document.getElementById('view-toolbar'),
    viewContent: document.getElementById('view-content'),
    search: document.getElementById('global-search-input'),
    environment: document.getElementById('environment-select'),
    toast: document.getElementById('toast-region'),
    dialog: document.getElementById('prototype-dialog'),
    dialogTitle: document.getElementById('prototype-dialog-title'),
    dialogBody: document.getElementById('prototype-dialog-body'),
  };

  const statusMeta = {
    running: { label: '运行中', icon: 'clock' },
    waiting: { label: '等待审核', icon: 'clock' },
    repairing: { label: '返修中', icon: 'edit' },
    draft: { label: '草稿', icon: 'artifact' },
    failed: { label: '失败', icon: 'alert' },
    delivered: { label: '已交付', icon: 'check' },
    completed: { label: '已完成', icon: 'check' },
    verified: { label: '已验证', icon: 'check' },
    passed: { label: '已通过', icon: 'check' },
    superseded: { label: '已替代', icon: 'artifact' },
    applied: { label: '已执行', icon: 'edit' },
  };

  const kindLabels = {
    brief: '任务拆解',
    artifact: '产物提交',
    review: '审核复核',
    instruction: '返修指令',
    delivery: '系统门禁',
  };

  const evolutionMeta = {
    version: { label: '产物版本', icon: 'artifact' },
    issue: { label: '阻断问题', icon: 'alert' },
    instruction: { label: '返修指令', icon: 'edit' },
    verified: { label: '验证事件', icon: 'check' },
  };

  const taskActionMeta = {
    pause: { label: '暂停', icon: 'pause', className: 'button-secondary' },
    stop: { label: '停止', icon: 'stop', className: 'button-danger' },
    retry: { label: '重试', icon: 'retry', className: 'button-secondary' },
    'copy-result': { label: '复制结果', icon: 'artifact', className: 'button-secondary' },
    'download-result': { label: '下载结果', icon: 'link', className: 'button-secondary' },
    'new-from-task': { label: '基于此任务新建', icon: 'plus', className: 'button-primary' },
  };

  let state = {
    ...stateApi.createInitialState(data),
    modelDetailAgentId: null,
    environment: 'production',
  };
  let lastRenderedView = state.view;
  let toastTimer = null;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => {
      const entities = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
      };
      return entities[character];
    });
  }

  function safeColor(value) {
    return /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : '#68707C';
  }

  function icon(name, className = '') {
    return `<svg class="icon ${escapeHtml(className)}" aria-hidden="true"><use href="#icon-${escapeHtml(name)}"></use></svg>`;
  }

  function statusBadge(status) {
    const meta = statusMeta[status] || { label: '未知状态', icon: 'info' };
    const safeStatus = Object.prototype.hasOwnProperty.call(statusMeta, status) ? status : 'draft';
    return `
      <span class="status-badge status-${safeStatus}">
        ${icon(meta.icon)}
        <span>${escapeHtml(meta.label)}</span>
      </span>
    `;
  }

  function announce(message) {
    global.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add('is-visible');
    toastTimer = global.setTimeout(() => {
      elements.toast.classList.remove('is-visible');
    }, 3200);
  }

  function focusAfterRender(selector) {
    global.requestAnimationFrame(() => {
      const target = document.querySelector(selector);
      if (target instanceof HTMLElement) {
        target.focus({ preventScroll: true });
      }
    });
  }

  function focusViewHeading() {
    global.requestAnimationFrame(() => {
      const heading = elements.viewTitle.querySelector('h1');
      if (heading instanceof HTMLElement) {
        heading.focus({ preventScroll: true });
      }
    });
  }

  function findPrimaryTask() {
    return data.primaryTask;
  }

  function findAgent(agentId) {
    return findPrimaryTask().agents.find((agent) => agent.id === agentId);
  }

  function findTurn(turnId) {
    return findPrimaryTask().turns.find((turn) => turn.id === turnId);
  }

  function findEvolution(evolutionId) {
    return findPrimaryTask().evolution.find((node) => node.id === evolutionId);
  }

  function renderApp() {
    const viewChanged = lastRenderedView !== state.view;
    renderShellState();

    if (state.view === 'templates') {
      renderTemplates();
    } else if (state.view === 'overview') {
      renderOverview(findPrimaryTask());
    } else if (state.view === 'trace') {
      renderTrace(findPrimaryTask());
    } else {
      renderWorkbench();
    }

    if (viewChanged) {
      focusViewHeading();
    }
    lastRenderedView = state.view;
  }

  function renderShellState() {
    const activeRootView = state.view === 'templates' ? 'templates' : 'workbench';

    document.querySelectorAll('[data-action="navigate"]').forEach((button) => {
      const isActive = button.dataset.view === activeRootView;
      if (isActive) {
        button.setAttribute('aria-current', 'page');
      } else {
        button.removeAttribute('aria-current');
      }
    });

    if (elements.search.value !== state.searchQuery) {
      elements.search.value = state.searchQuery;
    }
    if (elements.environment.value !== state.environment) {
      elements.environment.value = state.environment;
    }
  }

  function renderWorkbench() {
    const filteredTasks = stateApi.filterTasks(
      data.tasks,
      state.statusFilter,
      state.searchQuery,
    );
    const statusFilters = [
      ['all', '全部'],
      ['running', '运行中'],
      ['waiting', '等待审核'],
      ['repairing', '返修中'],
      ['draft', '草稿'],
      ['failed', '失败'],
      ['delivered', '已交付'],
    ];
    const summaryFilters = [
      { status: 'all', label: '全部任务', hint: '当前工作空间' },
      { status: 'running', label: '运行中', hint: '正在执行轮次' },
      { status: 'waiting', label: '等待审核', hint: '等待下一角色' },
      { status: 'repairing', label: '返修中', hint: '受控修改范围' },
    ];

    elements.viewTitle.innerHTML = `
      <div class="title-copy">
        <p class="eyebrow">Production workspace</p>
        <h1 tabindex="-1">生产工作台</h1>
        <p class="view-subtitle">查看任务状态、生产阶段与最近更新，进入一条任务追踪完整执行过程。</p>
      </div>
    `;

    elements.viewToolbar.innerHTML = `
      <div class="toolbar-group" aria-label="按状态筛选">
        ${statusFilters
          .map(
            ([value, label]) => `
              <button
                class="filter-button"
                type="button"
                data-action="set-status"
                data-status="${escapeHtml(value)}"
                aria-pressed="${state.statusFilter === value}"
              >
                ${escapeHtml(label)}
              </button>
            `,
          )
          .join('')}
      </div>
      <button
        class="button button-secondary"
        type="button"
        data-action="toggle-compact"
        aria-pressed="${state.compactTasks}"
      >
        ${icon(state.compactTasks ? 'workbench' : 'templates')}
        <span>${state.compactTasks ? '舒展列表' : '紧凑列表'}</span>
      </button>
    `;

    elements.viewContent.innerHTML = `
      <section class="summary-grid" aria-label="任务状态概览">
        ${summaryFilters
          .map((filter) => {
            const count =
              filter.status === 'all'
                ? data.tasks.length
                : data.tasks.filter((task) => task.status === filter.status).length;
            return `
              <button
                class="summary-card"
                type="button"
                data-action="set-status"
                data-status="${escapeHtml(filter.status)}"
                aria-pressed="${state.statusFilter === filter.status}"
                aria-label="${escapeHtml(filter.label)}，${count} 项"
              >
                <span>
                  <strong>${escapeHtml(filter.label)}</strong>
                  <small>${escapeHtml(filter.hint)}</small>
                </span>
                <output>${count}</output>
              </button>
            `;
          })
          .join('')}
      </section>
      <section class="panel" aria-labelledby="task-list-title">
        <div class="panel-header">
          <div>
            <h2 id="task-list-title" class="panel-title">生产任务</h2>
            <p class="panel-description">显示 ${filteredTasks.length} / ${data.tasks.length} 项模拟任务</p>
          </div>
          ${state.searchQuery ? `<span class="status-badge status-draft">${icon('search')}“${escapeHtml(state.searchQuery)}”</span>` : ''}
        </div>
        ${renderTaskRows(filteredTasks)}
      </section>
    `;
  }

  function renderTemplates() {
    elements.viewTitle.innerHTML = `
      <div class="title-copy">
        <p class="eyebrow">Template center</p>
        <h1 tabindex="-1">模板中心</h1>
        <p class="view-subtitle">用于说明不同内容流程的结构与阶段；本页仅提供浅层预览。</p>
      </div>
    `;
    elements.viewToolbar.innerHTML = `
      <div class="toolbar-group">
        <span class="status-badge status-draft">${icon('templates')}3 个示例模板</span>
      </div>
      <button class="button button-secondary" type="button" data-action="new-task">
        ${icon('plus')}
        <span>从模板新建</span>
      </button>
    `;
    elements.viewContent.innerHTML = `
      <section class="template-grid" aria-label="模板卡片">
        ${data.templates
          .map(
            (template) => `
              <article class="panel template-card">
                <div>
                  <span class="template-icon" aria-hidden="true">${icon('templates')}</span>
                  <p class="eyebrow">${escapeHtml(template.category)}</p>
                  <h2>${escapeHtml(template.name)}</h2>
                  <p>${escapeHtml(template.description)}</p>
                </div>
                <div class="template-footer">
                  <span>${escapeHtml(template.stages)} 个阶段 · ${escapeHtml(template.updatedAt)}</span>
                  <button
                    class="link-button"
                    type="button"
                    data-action="template-preview"
                    data-template-id="${escapeHtml(template.id)}"
                  >
                    查看说明 ${icon('chevron')}
                  </button>
                </div>
              </article>
            `,
          )
          .join('')}
      </section>
    `;
  }

  function renderOverview(task) {
    elements.viewTitle.innerHTML = `
      <div class="title-copy">
        <p class="eyebrow">${escapeHtml(task.displayId)} · Task overview</p>
        <h1 tabindex="-1">任务总览</h1>
        <p class="view-subtitle">检查任务、参与角色、当前产物与系统交付门禁。</p>
      </div>
    `;
    elements.viewToolbar.innerHTML = `
      <div class="toolbar-group">
        <button class="button button-quiet" type="button" data-action="back-workbench">
          ${icon('arrow-left')}
          <span>返回工作台</span>
        </button>
        ${statusBadge(task.status)}
      </div>
      <button class="button button-primary" type="button" data-action="open-trace">
        ${icon('trace')}
        <span>查看执行轨迹</span>
      </button>
    `;

    elements.viewContent.innerHTML = `
      <div class="overview-stack">
        <section class="panel overview-hero" aria-labelledby="overview-task-title">
          <div>
            ${statusBadge(task.status)}
            <h2 id="overview-task-title">${escapeHtml(task.title)}</h2>
            <p class="overview-summary">${escapeHtml(task.summary)}</p>
            <div class="hero-meta">
              <span>${icon('templates')} ${escapeHtml(task.template)}</span>
              <span>${icon('clock')} 更新于 ${escapeHtml(task.updatedAt)}</span>
              <span>${icon('agent')} ${escapeHtml(task.agents.length)} 个执行角色</span>
            </div>
          </div>
          <div class="hero-actions" aria-label="任务模拟操作">
            ${renderTaskActions(task.status)}
          </div>
        </section>

        <div class="overview-grid">
          <section class="panel" aria-labelledby="agent-overview-title">
            <div class="panel-header">
              <div>
                <h2 id="agent-overview-title" class="panel-title">参与角色与模型</h2>
                <p class="panel-description">模型来源被明确标注，切换操作仅作演示。</p>
              </div>
            </div>
            <div class="agent-overview-list">
              ${task.agents.map((agent) => renderAgentOverviewCard(agent)).join('')}
            </div>
          </section>

          <section class="panel" aria-labelledby="delivery-title">
            <div class="panel-header">
              <div>
                <h2 id="delivery-title" class="panel-title">交付门禁</h2>
                <p class="panel-description">由系统独立核对，不以 Agent 声明为准。</p>
              </div>
              ${statusBadge('passed')}
            </div>
            <div class="delivery-list">
              ${task.deliveryChecks
                .map(
                  (check) => `
                    <div class="delivery-check">
                      <span class="check-icon" aria-hidden="true">${icon('check')}</span>
                      <span>
                        <strong>${escapeHtml(check.label)}</strong>
                        <small>${escapeHtml(check.detail)}</small>
                      </span>
                    </div>
                  `,
                )
                .join('')}
            </div>
          </section>
        </div>

        ${renderArtifactPanel(task)}
      </div>
    `;
  }

  function renderTaskActions(status) {
    return stateApi
      .getTaskActions(status)
      .map((actionId) => {
        const action = taskActionMeta[actionId];
        if (!action) {
          return '';
        }
        return `
          <button
            class="button ${action.className}"
            type="button"
            data-action="notice"
            data-notice="${escapeHtml(actionId)}"
          >
            ${icon(action.icon)}<span>${escapeHtml(action.label)}</span>
          </button>
        `;
      })
      .join('');
  }

  function renderAgentOverviewCard(agent) {
    const isExpanded = state.modelDetailAgentId === agent.id;
    const panelId = `model-detail-${agent.id}`;
    return `
      <article class="agent-overview-card" style="--agent-color: ${safeColor(agent.color)}">
        <div class="agent-card-head">
          <span class="agent-avatar" aria-hidden="true">${icon('agent')}</span>
          <span>
            <strong>${escapeHtml(agent.name)}</strong>
            <small>${escapeHtml(agent.role)}</small>
          </span>
        </div>
        <div class="agent-model-row">
          <span class="model-name">${escapeHtml(agent.model)}</span>
          <button
            class="link-button"
            type="button"
            data-action="model-detail"
            data-agent-id="${escapeHtml(agent.id)}"
            aria-expanded="${isExpanded}"
            aria-controls="${escapeHtml(panelId)}"
          >
            ${isExpanded ? '收起详情' : '模型详情'}
          </button>
        </div>
        ${
          isExpanded
            ? `
              <div id="${escapeHtml(panelId)}" class="model-disclosure">
                <dl>
                  <dt>提供方</dt><dd>${escapeHtml(agent.provider)}</dd>
                  <dt>模型</dt><dd>${escapeHtml(agent.model)}</dd>
                  <dt>来源</dt><dd>${escapeHtml(agent.modelSource)}</dd>
                </dl>
                <button
                  class="link-button"
                  type="button"
                  data-action="notice"
                  data-notice="model-change"
                >
                  ${icon('model')} 模拟切换模型
                </button>
              </div>
            `
            : ''
        }
      </article>
    `;
  }

  function renderTrace(task) {
    elements.viewTitle.innerHTML = `
      <div class="title-copy">
        <p class="eyebrow">${escapeHtml(task.displayId)} · Execution trace</p>
        <h1 tabindex="-1">执行轨迹</h1>
        <p class="view-subtitle">${escapeHtml(task.title)} · 点击角色、轮次或演进节点查看双向关联。</p>
      </div>
    `;
    elements.viewToolbar.innerHTML = `
      <div class="toolbar-group">
        <button class="button button-quiet" type="button" data-action="back-overview">
          ${icon('arrow-left')}
          <span>返回任务总览</span>
        </button>
        ${statusBadge(task.status)}
      </div>
      <button class="button button-secondary" type="button" data-action="back-workbench">
        ${icon('workbench')}<span>回到工作台</span>
      </button>
    `;

    elements.viewContent.innerHTML = `
      <div class="trace-stack">
        <section class="trace-layout" aria-label="执行轨迹三栏视图">
          ${renderAgentRail(task.agents)}
          ${renderTimeline(task.turns)}
          ${renderEvolution(task.evolution)}
          <div class="trace-artifact">
            ${renderArtifactPanel(task)}
          </div>
        </section>
      </div>
    `;
  }

  function renderTaskRows(tasks) {
    if (tasks.length === 0) {
      return `
        <div class="empty-state">
          <div>
            <span class="empty-icon" aria-hidden="true">${icon('search')}</span>
            <h3>没有匹配的任务</h3>
            <p>尝试清空搜索词或选择其他状态。当前搜索与筛选仍会被保留。</p>
          </div>
        </div>
      `;
    }

    return `
      <div class="task-list ${state.compactTasks ? 'is-compact' : ''}">
        ${tasks
          .map(
            (task) => `
              <button
                class="task-row"
                type="button"
                data-action="open-task"
                data-task-id="${escapeHtml(task.id)}"
                aria-label="打开任务 ${escapeHtml(task.title)}"
              >
                <span class="task-primary">
                  <span class="task-id">${escapeHtml(task.displayId)}</span>
                  <h3>${escapeHtml(task.title)}</h3>
                  <p>${escapeHtml(task.summary)}</p>
                </span>
                <span class="task-meta">
                  <span class="meta-label">生产模板</span>
                  <strong>${escapeHtml(task.template)}</strong>
                  <small>${escapeHtml(task.updatedAt)}</small>
                </span>
                <span class="task-meta">
                  <span class="meta-label">当前阶段</span>
                  <strong>${escapeHtml(task.phase)}</strong>
                  <small>进度 ${escapeHtml(task.progress)}%</small>
                </span>
                <span class="task-end">
                  ${statusBadge(task.status)}
                  ${icon('chevron')}
                </span>
              </button>
            `,
          )
          .join('')}
      </div>
    `;
  }

  function renderAgentRail(agents) {
    return `
      <section class="panel trace-panel agent-rail" aria-labelledby="agent-rail-title">
        <div class="trace-panel-header">
          <h2 id="agent-rail-title">执行角色</h2>
          <p>再次点击可取消筛选</p>
        </div>
        <div class="agent-rail-list">
          ${agents
            .map((agent) => {
              const isSelected = state.selectedAgentId === agent.id;
              return `
                <button
                  class="agent-rail-button ${isSelected ? 'is-selected' : ''}"
                  type="button"
                  data-action="select-agent"
                  data-agent-id="${escapeHtml(agent.id)}"
                  aria-pressed="${isSelected}"
                  style="--agent-color: ${safeColor(agent.color)}"
                >
                  <span class="agent-dot" aria-hidden="true">${icon('agent')}</span>
                  <span>
                    <strong>${escapeHtml(agent.name)}</strong>
                    <small>${escapeHtml(agent.role)}</small>
                  </span>
                </button>
              `;
            })
            .join('')}
        </div>
      </section>
    `;
  }

  function renderTimeline(turns) {
    return `
      <section class="panel trace-panel timeline-panel" aria-labelledby="timeline-title">
        <div class="trace-panel-header">
          <h2 id="timeline-title">Turn 时间线</h2>
          <p>共 ${turns.length} 轮，按持久化顺序展示</p>
        </div>
        <div class="timeline-list">
          ${turns
            .map((turn) => {
              const agent = findAgent(turn.agentId);
              const isSelected = state.selectedTimelineId === turn.id;
              const isDimmed = state.selectedAgentId && state.selectedAgentId !== turn.agentId;
              return `
                <button
                  class="timeline-turn ${isSelected ? 'is-selected' : ''} ${isDimmed ? 'is-dimmed' : ''}"
                  type="button"
                  data-action="select-turn"
                  data-turn-id="${escapeHtml(turn.id)}"
                  aria-pressed="${isSelected}"
                  style="--agent-color: ${safeColor(agent?.color)}"
                >
                  <span class="turn-sequence">${escapeHtml(turn.sequence)}</span>
                  <span class="turn-copy">
                    <span class="turn-title-row">
                      <strong>${escapeHtml(turn.title)}</strong>
                      <span class="kind-label">${escapeHtml(kindLabels[turn.kind] || '执行轮次')}</span>
                    </span>
                    <p>${escapeHtml(turn.summary)}</p>
                    <span class="turn-agent">${escapeHtml(agent?.name || '未知角色')}</span>
                    ${
                      turn.linkedEvolutionId
                        ? `<span class="linked-indicator">${icon('link')}关联演进节点</span>`
                        : ''
                    }
                  </span>
                  <time class="turn-time">${escapeHtml(turn.time)}</time>
                </button>
              `;
            })
            .join('')}
        </div>
      </section>
    `;
  }

  function renderEvolution(nodes) {
    return `
      <section class="panel trace-panel evolution-rail" aria-labelledby="evolution-title">
        <div class="trace-panel-header">
          <h2 id="evolution-title">产物演进链</h2>
          <p>版本、问题、指令与验证事件</p>
        </div>
        <div class="evolution-list">
          ${nodes
            .map((node) => {
              const meta = evolutionMeta[node.type] || { label: '演进节点', icon: 'info' };
              const isSelected = state.selectedEvolutionId === node.id;
              return `
                <button
                  class="evolution-node ${isSelected ? 'is-selected' : ''}"
                  type="button"
                  data-action="select-evolution"
                  data-evolution-id="${escapeHtml(node.id)}"
                  aria-pressed="${isSelected}"
                >
                  <span class="evolution-node-head">
                    <span class="evolution-type">${icon(meta.icon)}${escapeHtml(meta.label)}</span>
                    <time>${escapeHtml(node.time)}</time>
                  </span>
                  <h3>${escapeHtml(node.title)}</h3>
                  <p>${escapeHtml(node.summary)}</p>
                  ${
                    node.linkedTimelineId
                      ? `<span class="linked-indicator">${icon('link')}关联 Turn</span>`
                      : ''
                  }
                </button>
              `;
            })
            .join('')}
        </div>
      </section>
    `;
  }

  function renderArtifactPanel(task) {
    const currentVersion =
      task.artifactVersions.find((version) => version.current) ||
      task.artifactVersions[task.artifactVersions.length - 1];
    const beforeVersion = task.artifactVersions[0];
    const afterVersion = task.artifactVersions[1];
    const content =
      state.artifactMode === 'diff'
        ? renderDiff(beforeVersion.lines, afterVersion.lines)
        : `
          <article class="artifact-copy" aria-label="${escapeHtml(task.artifactTitle)}正文">
            ${currentVersion.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')}
          </article>
        `;

    return `
      <section class="panel artifact-panel" aria-labelledby="artifact-panel-title">
        <div class="artifact-toolbar">
          <div>
            <p class="eyebrow">Current artifact</p>
            <h2 id="artifact-panel-title" class="panel-title">${escapeHtml(task.artifactTitle)}</h2>
            <div class="artifact-version-meta">
              ${statusBadge(currentVersion.status)}
              <span class="panel-description">${escapeHtml(currentVersion.label)} · ${escapeHtml(currentVersion.time)}</span>
            </div>
          </div>
          <div class="artifact-mode-switch" role="group" aria-label="产物查看模式">
            <button
              class="segmented-button"
              type="button"
              data-action="artifact-mode"
              data-artifact-mode="content"
              aria-pressed="${state.artifactMode === 'content'}"
            >
              ${icon('artifact')} 正文
            </button>
            <button
              class="segmented-button"
              type="button"
              data-action="artifact-mode"
              data-artifact-mode="diff"
              aria-pressed="${state.artifactMode === 'diff'}"
            >
              ${icon('diff')} Diff
            </button>
          </div>
        </div>
        ${content}
      </section>
    `;
  }

  function renderDiff(beforeLines, afterLines) {
    const rowCount = Math.max(beforeLines.length, afterLines.length);
    const rows = [];

    for (let index = 0; index < rowCount; index += 1) {
      const before = beforeLines[index] ?? '';
      const after = afterLines[index] ?? '';
      const changed = before !== after;
      rows.push(`
        <div class="diff-row">
          <div class="diff-cell ${changed ? 'is-before' : ''}">
            <span class="diff-marker">${changed ? '−' : '·'}</span>
            <span class="diff-label">${changed ? '删除' : '保留'}</span>
            <span>${escapeHtml(before || '（此行不存在）')}</span>
          </div>
          <div class="diff-cell ${changed ? 'is-after' : ''}">
            <span class="diff-marker">${changed ? '+' : '·'}</span>
            <span class="diff-label">${changed ? '新增' : '保留'}</span>
            <span>${escapeHtml(after || '（此行不存在）')}</span>
          </div>
        </div>
      `);
    }

    return `
      <div class="diff-view" aria-label="初稿 v1 与返修稿 v2 的逐行差异">
        <div class="diff-head" aria-hidden="true">
          <div>− 删除 · 初稿 v1</div>
          <div>+ 新增 · 返修稿 v2</div>
        </div>
        ${rows.join('')}
      </div>
    `;
  }

  function showPrototypeNotice(title, body) {
    elements.dialogTitle.textContent = title;
    elements.dialogBody.textContent = body;
    if (typeof elements.dialog.showModal === 'function') {
      if (!elements.dialog.open) {
        elements.dialog.showModal();
      }
    } else {
      elements.dialog.setAttribute('open', '');
    }
  }

  function closeDialog() {
    if (typeof elements.dialog.close === 'function' && elements.dialog.open) {
      elements.dialog.close();
    } else {
      elements.dialog.removeAttribute('open');
    }
  }

  function handleNotice(noticeType) {
    const notices = {
      pause: {
        title: '暂停任务 · 原型演示',
        body: '此按钮仅展示暂停入口。离线原型不会改变任务状态，也不会向 Worker 发送命令。',
      },
      stop: {
        title: '停止任务 · 原型演示',
        body: '真实产品中，停止前应再次确认并记录事件；此处不会执行停止或删除任何数据。',
      },
      retry: {
        title: '重试轮次 · 原型演示',
        body: '此入口用于演示失败恢复位置。离线原型不会创建新 Turn，也不会声称重试成功。',
      },
      'copy-result': {
        title: '复制结果 · 原型演示',
        body: '此入口仅说明已交付结果的复制位置。离线原型不会写入剪贴板，也不会声称已经复制。',
      },
      'download-result': {
        title: '下载结果 · 原型演示',
        body: '此入口仅说明已交付结果的下载位置。离线原型不会生成文件，也不会触发真实下载。',
      },
      'new-from-task': {
        title: '基于此任务新建 · 原型演示',
        body: '此入口用于说明终态任务的后续生产路径。离线原型不会创建 Case、保存配置或启动生产。',
      },
      'model-change': {
        title: '切换模型 · 原型演示',
        body: '真实产品中，模型变更需要明确来源与作用范围；此处不会保存配置或调用任何模型。',
      },
    };
    const notice = notices[noticeType] || {
      title: '原型演示',
      body: '此操作在离线原型中不会产生真实效果。',
    };
    showPrototypeNotice(notice.title, notice.body);
  }

  document.addEventListener('click', (event) => {
    const actionElement = event.target.closest('[data-action]');
    if (!(actionElement instanceof HTMLElement)) {
      return;
    }

    const { action } = actionElement.dataset;

    if (action === 'navigate') {
      state = stateApi.setView(state, actionElement.dataset.view);
      renderApp();
      return;
    }

    if (action === 'set-status') {
      const status = actionElement.dataset.status || 'all';
      state = { ...state, statusFilter: status };
      renderApp();
      focusAfterRender(`[data-action="set-status"][data-status="${status}"]`);
      announce(`已筛选：${status === 'all' ? '全部任务' : statusMeta[status]?.label || '未知状态'}`);
      return;
    }

    if (action === 'toggle-compact') {
      state = { ...state, compactTasks: !state.compactTasks };
      renderApp();
      focusAfterRender('[data-action="toggle-compact"]');
      return;
    }

    if (action === 'open-task') {
      const taskId = actionElement.dataset.taskId;
      if (taskId === data.primaryTask.id) {
        state = stateApi.selectTask(state, taskId);
        renderApp();
      } else {
        showPrototypeNotice(
          '浅层任务记录',
          `为保持原型聚焦，只有“${data.primaryTask.title}”配置了完整总览、执行轨迹和产物演进；其他任务用于演示列表状态。`,
        );
      }
      return;
    }

    if (action === 'open-trace') {
      state = stateApi.setView(state, 'trace');
      renderApp();
      return;
    }

    if (action === 'back-overview') {
      state = stateApi.setView(state, 'overview');
      renderApp();
      return;
    }

    if (action === 'back-workbench') {
      state = stateApi.setView(state, 'workbench');
      renderApp();
      return;
    }

    if (action === 'select-agent') {
      const agentId = actionElement.dataset.agentId;
      if (findAgent(agentId)) {
        state = stateApi.selectAgent(state, agentId);
        renderApp();
        focusAfterRender(`[data-action="select-agent"][data-agent-id="${agentId}"]`);
        announce(state.selectedAgentId ? '已聚焦该角色的执行轮次' : '已显示全部角色轮次');
      }
      return;
    }

    if (action === 'select-turn') {
      const turn = findTurn(actionElement.dataset.turnId);
      if (turn) {
        state = stateApi.selectTimeline(state, turn);
        renderApp();
        focusAfterRender(`[data-action="select-turn"][data-turn-id="${turn.id}"]`);
      }
      return;
    }

    if (action === 'select-evolution') {
      const node = findEvolution(actionElement.dataset.evolutionId);
      if (node) {
        state = stateApi.selectEvolution(state, node);
        renderApp();
        focusAfterRender(
          `[data-action="select-evolution"][data-evolution-id="${node.id}"]`,
        );
      }
      return;
    }

    if (action === 'artifact-mode') {
      const mode = actionElement.dataset.artifactMode === 'diff' ? 'diff' : 'content';
      state = { ...state, artifactMode: mode };
      renderApp();
      focusAfterRender(`[data-action="artifact-mode"][data-artifact-mode="${mode}"]`);
      return;
    }

    if (action === 'model-detail') {
      const agentId = actionElement.dataset.agentId;
      state = {
        ...state,
        modelDetailAgentId: state.modelDetailAgentId === agentId ? null : agentId,
      };
      renderApp();
      focusAfterRender(`[data-action="model-detail"][data-agent-id="${agentId}"]`);
      return;
    }

    if (action === 'new-task') {
      showPrototypeNotice(
        '新建生产任务 · 原型演示',
        '此离线页面只展示入口与交互层级，不会创建 Case、写入数据库或调用模型。',
      );
      return;
    }

    if (action === 'notice') {
      handleNotice(actionElement.dataset.notice);
      return;
    }

    if (action === 'template-preview') {
      showPrototypeNotice(
        '模板说明 · 浅层预览',
        '模板卡片用于展示信息层级。此原型不加载场景 YAML，也不修改现有模板。',
      );
      return;
    }

    if (action === 'close-dialog') {
      closeDialog();
    }
  });

  document.addEventListener('input', (event) => {
    if (event.target === elements.search) {
      state = {
        ...state,
        searchQuery: elements.search.value,
        view: 'workbench',
      };
      renderApp();
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target === elements.environment) {
      state = { ...state, environment: elements.environment.value };
      announce(`已切换到${state.environment === 'production' ? '生产' : '测试'}环境（模拟）`);
    }
  });

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const isTyping =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;

    if (event.key === '/' && !isTyping) {
      event.preventDefault();
      elements.search.focus();
    }

    if (event.key === 'Escape' && elements.dialog.open) {
      event.preventDefault();
      closeDialog();
    }
  });

  elements.dialog.addEventListener('click', (event) => {
    if (event.target === elements.dialog) {
      closeDialog();
    }
  });

  elements.dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDialog();
  });

  renderApp();
})(window, document);
