/**
 * 只读回放页面 · 泳道时间线版
 * 轮询刷新（不做 SSE）。服务端取数 → 客户端 LaneBoard 画泳道+箭头。
 */

import { getCases, getMessages, getArtifactVersions, getIssues, getDeliveryGateResults, getTurns, getRouteEdges, getToolActions, getRevisionInstructions, getContextSnapshots } from '../lib/db';
import type { CaseRecord, MessageRecord, ArtifactVersionRecord, IssueRecord, DeliveryGateResultRecord, TurnRecord, RouteEdgeRecord, ToolActionRecord, RevisionInstructionRecord } from '../lib/db';
import { AutoRefresh } from './auto-refresh';
import { LaneBoard } from './lane-board';
import { VersionDiff } from './version-diff';
import type { AgentInfo, TurnData, RouteEdgeData, ToolActionData, MessageData } from './lane-board';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: { case?: string };
}

interface ScenarioAgent {
  key: string;
  name: string;
  model: string;
  session?: { policy?: string };
  tools?: string[];
}

function parseAgents(snapshotJson: string): AgentInfo[] {
  try {
    const snap = JSON.parse(snapshotJson);
    const raw: ScenarioAgent[] = Array.isArray(snap?.agents) ? snap.agents : [];
    return raw.map((a) => ({
      key: a.key,
      name: a.name ?? a.key,
      model: a.model ?? '',
      session_policy: a.session?.policy ?? '',
      tools: a.tools ?? [],
    }));
  } catch {
    return [];
  }
}

function statusDotClass(status: string): string {
  if (['approved', 'delivered'].includes(status)) return 'dot-approved';
  if (['running'].includes(status)) return 'dot-running';
  if (['waiting_review', 'repairing', 'waiting_recovery', 'waiting_human'].includes(status)) return 'dot-waiting';
  if (['failed', 'stopped', 'rejected'].includes(status)) return 'dot-failed';
  return 'dot-idle';
}

export default function Home({ searchParams }: PageProps) {
  const cases = getCases();
  const selectedCaseId = searchParams.case ?? cases[0]?.case_id;
  const selectedCase = selectedCaseId ? cases.find((c) => c.case_id === selectedCaseId) ?? null : null;

  const messages: MessageRecord[] = selectedCaseId ? getMessages(selectedCaseId) : [];
  const versions: ArtifactVersionRecord[] = selectedCaseId ? getArtifactVersions(selectedCaseId) : [];
  const issues: IssueRecord[] = selectedCaseId ? getIssues(selectedCaseId) : [];
  const gateResults: DeliveryGateResultRecord[] = selectedCaseId ? getDeliveryGateResults(selectedCaseId) : [];
  const turnRows: TurnRecord[] = selectedCaseId ? getTurns(selectedCaseId) : [];
  const routeEdgeRows: RouteEdgeRecord[] = selectedCaseId ? getRouteEdges(selectedCaseId) : [];
  const toolActionRows: ToolActionRecord[] = selectedCaseId ? getToolActions(selectedCaseId) : [];
  const revisionInstructionRows: RevisionInstructionRecord[] = selectedCaseId ? getRevisionInstructions(selectedCaseId) : [];
  const contextSnapshotRows = selectedCaseId ? getContextSnapshots(selectedCaseId) : [];
  const contextByTurn: Record<string, string> = {};
  for (const cs of contextSnapshotRows) {
    if (cs.turn_id) contextByTurn[cs.turn_id] = cs.rendered_context;
  }

  const agents: AgentInfo[] = selectedCase ? parseAgents(selectedCase.scenario_snapshot) : [];

  const avVersion: Record<string, number> = {};
  for (const v of versions) avVersion[v.artifact_version_id] = v.version;

  const versionById = new Map(versions.map((v) => [v.artifact_version_id, v]));
  const parseAnchors = (json: string): number[] => {
    try {
      return (JSON.parse(json) as string[]).map((s) => parseInt(s.replace('line:', ''), 10)).filter((n) => !Number.isNaN(n));
    } catch {
      return [];
    }
  };
  const diffDataFor = (v: ArtifactVersionRecord): { before: string; after: string; changed: number[]; editable: number[]; frozen: number[] } | null => {
    if (!v.diff) return null;
    let changed: number[] = [];
    try { changed = JSON.parse(v.diff) as number[]; } catch { return null; }
    const parent = v.parent_version_id ? versionById.get(v.parent_version_id) : null;
    const ri = revisionInstructionRows.find((r) => r.target_artifact_version_id === v.artifact_version_id)
      ?? revisionInstructionRows.find((r) => r.status === 'verified')
      ?? revisionInstructionRows[0];
    return {
      before: parent?.content ?? '',
      after: v.content,
      changed,
      editable: ri ? parseAnchors(ri.editable_anchors) : [],
      frozen: ri ? parseAnchors(ri.frozen_anchors) : [],
    };
  };

  const turns: TurnData[] = turnRows.map((t) => ({
    turn_id: t.turn_id,
    sequence: t.sequence,
    status: t.status,
    agent_key: t.agent_key,
    session_policy: t.session_policy,
    session_id: t.session_id,
    input_message_id: t.input_message_id,
    output_message_id: t.output_message_id,
    produced_artifact_version_ids: (() => {
      try { return JSON.parse(t.produced_artifact_version_ids) as string[]; } catch { return []; }
    })(),
    started_at: t.started_at,
    finished_at: t.finished_at,
    provider_error: t.provider_error,
  }));

  const routeEdges: RouteEdgeData[] = routeEdgeRows.map((e) => ({
    route_id: e.route_id,
    source_message_id: e.source_message_id,
    target_message_id: e.target_message_id,
    source_agent: e.source_agent,
    target_agent: e.target_agent,
    reason: e.reason,
  }));

  const toolActions: ToolActionData[] = toolActionRows.map((ta) => ({
    action_id: ta.action_id,
    turn_id: ta.turn_id,
    tool_name: ta.tool_name,
    arguments: (() => { try { return JSON.parse(ta.arguments); } catch { return ta.arguments; } })(),
    result: ta.result ? (() => { try { return JSON.parse(ta.result); } catch { return ta.result; } })() : null,
    status: ta.status,
  }));

  const messageData: MessageData[] = messages.map((m) => ({
    message_id: m.message_id,
    content: m.content,
    message_type: m.message_type,
    source_agent: m.source_agent,
    target_agent: m.target_agent,
  }));

  // FAIL CLOSED 横幅：waiting_human 或最新门禁 fail 且未 approved 时显示
  const latestGate = gateResults[0] ?? null;
  const humanAction = [...toolActions].reverse().find((ta) => ta.tool_name === 'request_human_input');
  let banner: { kind: 'human' | 'gate'; title: string; detail: string; code: string } | null = null;
  if (selectedCase) {
    if (selectedCase.status === 'waiting_human' && humanAction) {
      const args = humanAction.arguments as { reason?: string; question?: string };
      banner = {
        kind: 'human',
        title: '等待人工输入 · 已安全暂停',
        detail: [args.reason, args.question].filter(Boolean).join(' / '),
        code: 'waiting_human',
      };
    } else if (latestGate && latestGate.status === 'fail' && selectedCase.status !== 'approved') {
      const checks = JSON.parse(latestGate.checks) as { check: string; passed: boolean; detail?: string }[];
      const failed = checks.filter((c) => !c.passed);
      banner = {
        kind: 'gate',
        title: '交付门禁拦截 · FAIL CLOSED',
        detail: failed.map((c) => `${c.check}：${c.detail ?? ''}`).join(' · '),
        code: failed[0]?.check ?? 'gate_fail',
      };
    }
  }

  const scenarioName = (() => {
    try { return JSON.parse(selectedCase?.scenario_snapshot ?? '{}')?.scenario?.name ?? ''; } catch { return ''; }
  })();

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">F</div>
          <div>
            <p className="eyebrow">FORGE AI · PRODUCTION REPLAY</p>
            <h1>多 Agent 协作生产 <span>· 泳道回放</span></h1>
          </div>
        </div>
        <div className="top-status">
          <i className={selectedCase ? 'live' : ''} />
          <span>{selectedCase ? selectedCase.status : '未选择 Case'}</span>
        </div>
      </header>

      <main>
        <div className="workspace">
          {/* 任务轨道 */}
          <aside className="task-rail">
            <div className="rail-head">
              <h2>生产任务</h2>
              <span className="count">{cases.length}</span>
            </div>
            <p className="rail-note">只读回放 · 5 秒轮询 · 不调用 Pi</p>
            <div className="task-list">
              {cases.map((c) => (
                <a key={c.case_id} href={`/?case=${c.case_id}`} className="task-item-link">
                  <article className={`task-item${c.case_id === selectedCaseId ? ' active' : ''}`}>
                    <div className="task-main">
                      <div className="task-title-row">
                        <i className={`task-status ${statusDotClass(c.status)}`} />
                        <div className="task-name-wrap">
                          <b className="task-name">{c.title}</b>
                          <span className="task-case">{c.case_id}</span>
                        </div>
                      </div>
                      <div className="task-meta">
                        <span>{c.status}</span>
                      </div>
                    </div>
                  </article>
                </a>
              ))}
            </div>
          </aside>

          {/* 主区 */}
          <section className="trace">
            {selectedCase ? (
              <>
                <div className="trace-head">
                  <div>
                    <h2>{selectedCase.title}</h2>
                    <p className="case-id">{selectedCase.case_id} · {scenarioName}</p>
                  </div>
                  <div className="trace-meta">
                    <span className={`badge badge-${selectedCase.status}`}>{selectedCase.status}</span>
                    <span className="chip">{turns.length} 个 Turn</span>
                    <span className="chip">{versions.length} 个版本</span>
                    <span className="chip">{issues.length} 个 Issue</span>
                  </div>
                </div>

                {banner && (
                  <div className={`blocking-banner banner-${banner.kind}`}>
                    <div className="blocking-mark">{banner.kind === 'human' ? '人' : '!'}</div>
                    <div className="blocking-copy">
                      <strong>{banner.title}</strong>
                      <span>{banner.detail}</span>
                    </div>
                    <span className="blocking-code">{banner.code}</span>
                  </div>
                )}

                <LaneBoard
                  turns={turns}
                  routeEdges={routeEdges}
                  toolActions={toolActions}
                  messages={messageData}
                  agents={agents}
                  avVersion={avVersion}
                  contextByTurn={contextByTurn}
                  caseStatus={selectedCase.status}
                />

                {/* 支撑区：产物版本 */}
                <section className="supporting">
                  <h3>产物版本</h3>
                  {versions.length === 0 ? (
                    <p className="empty">无版本</p>
                  ) : (
                    versions.map((v) => (
                      <div key={v.artifact_version_id} className={`card version-card version-${v.status}`}>
                        <div className="card-header">
                          <strong>v{v.version}</strong>
                          <span className={`badge badge-${v.status}`}>{v.status}</span>
                        </div>
                        <pre className="version-content">{v.content}</pre>
                        {v.summary && <small className="version-summary">{v.summary}</small>}
                        {v.diff && (
                          <details>
                            <summary>查看行级 Diff（editable / frozen）</summary>
                            {(() => {
                              const dd = diffDataFor(v);
                              return dd ? (
                                <VersionDiff
                                  before={dd.before}
                                  after={dd.after}
                                  changedLines={dd.changed}
                                  editableLines={dd.editable}
                                  frozenLines={dd.frozen}
                                />
                              ) : (
                                <pre className="version-diff">{v.diff}</pre>
                              );
                            })()}
                          </details>
                        )}
                      </div>
                    ))
                  )}
                </section>

                {/* 支撑区：Issues */}
                <section className="supporting">
                  <h3>Issues</h3>
                  {issues.length === 0 ? (
                    <p className="empty">无 Issue</p>
                  ) : (
                    issues.map((i) => (
                      <div key={i.issue_id} className={`card issue-item${i.severity === 'blocking' ? ' issue-blocking' : ''}`}>
                        <div className="card-header">
                          <span className={`badge badge-${i.status}`}>{i.status}</span>
                          <span className="agent-tag">{i.severity}</span>
                        </div>
                        <div><strong>问题：</strong>{i.problem}</div>
                        <div><strong>锚点：</strong>{i.anchor}</div>
                        {i.evidence && <div><strong>证据：</strong>{i.evidence}</div>}
                      </div>
                    ))
                  )}
                </section>

                {/* 支撑区：交付门禁 */}
                <section className="supporting">
                  <h3>交付门禁</h3>
                  {gateResults.length === 0 ? (
                    <p className="empty">无门禁记录</p>
                  ) : (
                    gateResults.map((g) => {
                      const checks = JSON.parse(g.checks) as { check: string; passed: boolean; detail?: string }[];
                      return (
                        <div key={g.gate_result_id} className="card">
                          <div className="card-header">
                            <strong>{g.status === 'pass' ? '✅ 通过' : '❌ 未通过'}</strong>
                            <small>{g.created_at}</small>
                          </div>
                          {checks.map((c, idx) => (
                            <div key={idx} className={`gate-check ${c.passed ? 'gate-pass' : 'gate-fail'}`}>
                              <span>{c.passed ? '✓' : '✗'}</span>
                              <span>{c.check}</span>
                              {c.detail && <small>({c.detail})</small>}
                            </div>
                          ))}
                        </div>
                      );
                    })
                  )}
                </section>
              </>
            ) : (
              <div className="lane-empty">
                <span>·</span>
                <strong>选择左侧任一 Case</strong>
                <p>查看其多 Agent 协作泳道与路由箭头</p>
              </div>
            )}
          </section>
        </div>
      </main>

      <AutoRefresh interval={5000} />
    </>
  );
}
