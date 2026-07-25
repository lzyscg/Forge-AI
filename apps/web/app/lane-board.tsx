'use client';

/**
 * 泳道时间线 + SVG 路由箭头
 * 设计理念借鉴 pi-pipline-main（仅理念，实现全重写）：
 *   - 每个 Turn = 一张卡片，落在其 agent 的泳道列，按 sequence 自上而下
 *   - 连续 Turn 之间画 SVG 曲线箭头，颜色按 route_edges.reason 分类
 *     （normal 蓝 / repair 琥珀=打回 / deliver 绿=交付 / system 蓝=系统调度）
 *   - 泳道、标签、图标、session 策略全部来自 scenario_snapshot.agents（配置驱动，零硬编码业务名）
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface AgentInfo {
  key: string;
  name: string;
  model: string;
  session_policy: string;
  tools: string[];
}

export interface TurnData {
  turn_id: string;
  sequence: number;
  status: string;
  agent_key: string;
  session_policy: string;
  session_id: string;
  input_message_id: string | null;
  output_message_id: string | null;
  produced_artifact_version_ids: string[];
  started_at: string | null;
  finished_at: string | null;
  provider_error: string | null;
}

export interface RouteEdgeData {
  route_id: string;
  source_message_id: string;
  target_message_id: string | null;
  source_agent: string;
  target_agent: string;
  reason: string | null;
}

export interface ToolActionData {
  action_id: string;
  turn_id: string;
  tool_name: string;
  arguments: unknown;
  result: unknown;
  status: string;
}

export interface MessageData {
  message_id: string;
  content: string;
  message_type: string;
  source_agent: string | null;
  target_agent: string | null;
}

interface Props {
  turns: TurnData[];
  routeEdges: RouteEdgeData[];
  toolActions: ToolActionData[];
  messages: MessageData[];
  agents: AgentInfo[];
  avVersion: Record<string, number>;
  contextByTurn: Record<string, string>;
  caseStatus: string;
}

type ArrowKind = 'system' | 'normal' | 'repair' | 'deliver';

const KIND_COLOR: Record<ArrowKind, string> = {
  system: '#5b7cfa',
  normal: '#5b7cfa',
  repair: '#d8872f',
  deliver: '#1c9b69',
};
const KIND_LABEL: Record<ArrowKind, string> = {
  system: '调度',
  normal: '路由',
  repair: '打回',
  deliver: '交付',
};

const STATUS_LABEL: Record<string, string> = {
  queued: '排队',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  incomplete: '不完整',
};

const TERMINAL_STATUSES = new Set(['approved', 'stopped', 'failed', 'rejected', 'waiting_human']);

interface ArrowDef {
  d: string;
  kind: ArrowKind;
  label: string;
  labelX: number;
  labelY: number;
}

/** 推断连续两个 Turn 之间箭头的类型 */
function classifyArrow(prev: TurnData, _cur: TurnData, routeEdges: RouteEdgeData[]): { kind: ArrowKind; reason: string | null } {
  const edge = routeEdges.find((e) => e.source_message_id === prev.output_message_id);
  if (!edge) return { kind: 'system', reason: null };
  const reason = edge.reason || '';
  if (/返修|打回|修改|repair|fix/i.test(reason)) return { kind: 'repair', reason };
  if (/交付|approve|deliver/i.test(reason)) return { kind: 'deliver', reason };
  return { kind: 'normal', reason };
}

function shortId(id: string | null): string {
  if (!id) return '';
  return id.length > 14 ? `…${id.slice(-12)}` : id;
}

/** 渲染实际模型输入（context_snapshots.rendered_context = 发给模型的 messages） */
function ModelInput({ rendered }: { rendered: string }) {
  try {
    const msgs = JSON.parse(rendered) as { role?: string; content?: string }[];
    if (!Array.isArray(msgs)) throw new Error('not array');
    return (
      <>
        {msgs.map((m, i) => (
          <div key={i} className={`mi-msg mi-${m.role ?? 'unknown'}`}>
            <span className="mi-role">{m.role ?? '?'}</span>
            <pre>{m.content ?? ''}</pre>
          </div>
        ))}
      </>
    );
  } catch {
    return <pre>{rendered}</pre>;
  }
}

export function LaneBoard(props: Props) {
  const { turns, routeEdges, toolActions, messages, agents, avVersion, contextByTurn, caseStatus } = props;
  const boardRef = useRef<HTMLDivElement>(null);
  const [arrows, setArrows] = useState<ArrowDef[]>([]);
  const [boardSize, setBoardSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  const messagesMap = new Map<string, MessageData>();
  for (const m of messages) messagesMap.set(m.message_id, m);

  // 泳道顺序：按 scenario_snapshot.agents 顺序；补齐任何未列出的 agent_key
  const laneKeys: string[] = [];
  for (const a of agents) laneKeys.push(a.key);
  for (const t of turns) {
    if (!laneKeys.includes(t.agent_key)) laneKeys.push(t.agent_key);
  }
  const laneMap = new Map<string, AgentInfo>();
  for (const a of agents) laneMap.set(a.key, a);

  // 进行中的泳道：Case 未终态时，最后一个 Turn 的 agent
  const inFlight = !TERMINAL_STATUSES.has(caseStatus);
  const activeLaneKey = inFlight && turns.length > 0 ? turns[turns.length - 1].agent_key : null;

  const draw = useCallback(() => {
    const board = boardRef.current;
    if (!board || turns.length === 0) {
      setArrows([]);
      return;
    }
    const boardBox = board.getBoundingClientRect();
    setBoardSize({ w: boardBox.width, h: boardBox.height });
    const next: ArrowDef[] = [];
    for (let i = 1; i < turns.length; i++) {
      const prevEl = board.querySelector(`[data-turn="${turns[i - 1].turn_id}"]`) as HTMLElement | null;
      const curEl = board.querySelector(`[data-turn="${turns[i].turn_id}"]`) as HTMLElement | null;
      if (!prevEl || !curEl) continue;
      const a = prevEl.getBoundingClientRect();
      const b = curEl.getBoundingClientRect();
      const x1 = a.left + a.width / 2 - boardBox.left;
      const y1 = a.bottom - boardBox.top;
      const x2 = b.left + b.width / 2 - boardBox.left;
      const y2 = b.top - boardBox.top;
      const midY = y1 + Math.max(14, (y2 - y1) / 2);
      const { kind } = classifyArrow(turns[i - 1], turns[i], routeEdges);
      next.push({
        d: `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2 - 5}`,
        kind,
        label: KIND_LABEL[kind],
        labelX: (x1 + x2) / 2,
        labelY: midY - 5,
      });
    }
    setArrows(next);
  }, [turns, routeEdges]);

  useLayoutEffect(() => {
    draw();
    const onResize = () => draw();
    window.addEventListener('resize', onResize);
    // 字体/图片加载后重测一次
    const t = window.setTimeout(draw, 200);
    return () => {
      window.removeEventListener('resize', onResize);
      window.clearTimeout(t);
    };
  }, [draw]);

  if (turns.length === 0) {
    return (
      <div className="lane-empty">
        <span>·</span>
        <strong>等待首个 Agent 轮次</strong>
        <p>Turn 卡片会按 agent 泳道自上而下排列，路由箭头连接连续轮次</p>
      </div>
    );
  }

  return (
    <div className="lane-board" ref={boardRef}>
      {/* 泳道头 */}
      <div className="lane-heads" style={{ gridTemplateColumns: `repeat(${laneKeys.length}, 1fr)` }}>
        {laneKeys.map((key) => {
          const info = laneMap.get(key);
          const name = info?.name ?? key;
          const icon = name.charAt(0);
          const active = key === activeLaneKey;
          return (
            <div key={key} className={`lane-head${active ? ' running' : ''}`}>
              <div className="agent-icon">{icon}</div>
              <div className="lane-title">
                <strong>{name}</strong>
                <small>{info?.session_policy ?? ''}{info?.model ? ` · ${info.model}` : ''}</small>
              </div>
              <span className="agent-state">{active ? '运行中' : '等待'}</span>
            </div>
          );
        })}
      </div>

      {/* 时间线 + 箭头 overlay */}
      <div className="timeline">
        <svg
          className="links"
          viewBox={`0 0 ${boardSize.w} ${boardSize.h}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            {(['system', 'normal', 'repair', 'deliver'] as ArrowKind[]).map((k) => (
              <marker
                key={k}
                id={`arrow-${k}`}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={KIND_COLOR[k]} />
              </marker>
            ))}
          </defs>
          {arrows.map((a, i) => (
            <g key={i}>
              <path d={a.d} className={`link-path link-${a.kind}`} markerEnd={`url(#arrow-${a.kind})`} />
              <text x={a.labelX} y={a.labelY} textAnchor="middle" className="link-label">
                {a.label}
              </text>
            </g>
          ))}
        </svg>

        {turns.map((turn, idx) => {
          const laneIdx = laneKeys.indexOf(turn.agent_key);
          const tools = toolActions.filter((t) => t.turn_id === turn.turn_id);
          const inputMsg = turn.input_message_id ? messagesMap.get(turn.input_message_id) : null;
          const outputMsg = turn.output_message_id ? messagesMap.get(turn.output_message_id) : null;
          const routeOut = routeEdges.find((e) => e.source_message_id === turn.output_message_id);
          const producedVers = turn.produced_artifact_version_ids
            .map((id) => avVersion[id])
            .filter((v) => typeof v === 'number');
          const active = turn.agent_key === activeLaneKey && idx === turns.length - 1;
          const incoming = inputMsg?.content ?? (idx === 0 ? '用户提交本次生产物料' : '系统调度进入本轮');

          return (
            <div className="turn-row" key={turn.turn_id} style={{ gridTemplateColumns: `repeat(${laneKeys.length}, 1fr)` }}>
              {laneKeys.map((key, li) => (
                <div key={key} className="turn-slot">
                  {li === laneIdx && (
                    <article
                      className={`turn-card turn-${turn.status}${active ? ' turn-active' : ''}`}
                      data-turn={turn.turn_id}
                    >
                      <header className="turn-head">
                        <span className="turn-number">{String(idx + 1).padStart(2, '0')}</span>
                        <div className="turn-heading">
                          <strong>{laneMap.get(key)?.name ?? key} · 第 {idx + 1} 轮</strong>
                          <small>sess {shortId(turn.session_id)}</small>
                        </div>
                        <span className={`state-tag state-${turn.status}`}>
                          {STATUS_LABEL[turn.status] ?? turn.status}
                        </span>
                      </header>
                      <div className="turn-body">
                        <div className="turn-section">
                          <div className="section-label">
                            <span>本轮业务输入</span>
                          </div>
                          <pre className="business-input">{incoming}</pre>
                        </div>

                        {tools.length > 0 && (
                          <div className="turn-section">
                            <div className="section-label">
                              <span>工具调用</span>
                              <span>{tools.length} 项</span>
                            </div>
                            <div className="tool-list">
                              {tools.map((ta) => (
                                <div key={ta.action_id} className={`tool-chip tool-${ta.tool_name} tool-${ta.status}`}>
                                  <span className="tool-name">{ta.tool_name}</span>
                                  <span className="tool-status">{ta.status}</span>
                                </div>
                              ))}
                            </div>
                            <details className="tool-args" onClick={() => requestAnimationFrame(draw)}>
                              <summary>工具参数 / 结果</summary>
                              <pre>{tools.map((ta) => `${ta.tool_name}:\n  args: ${JSON.stringify(ta.arguments, null, 2)}\n  result: ${ta.result == null ? 'null' : JSON.stringify(ta.result, null, 2)}`).join('\n\n')}</pre>
                            </details>
                          </div>
                        )}

                        {producedVers.length > 0 && (
                          <div className="turn-section">
                            <div className="section-label">
                              <span>产出产物</span>
                            </div>
                            <div className="version-chips">
                              {producedVers.map((v) => (
                                <span key={v} className="version-chip">v{v}</span>
                              ))}
                            </div>
                          </div>
                        )}

                        {(outputMsg?.content || turn.provider_error) && (
                          <div className="turn-section">
                            <div className="section-label">
                              <span>{turn.provider_error ? '错误' : '本轮产出'}</span>
                            </div>
                            <pre className="turn-output">{turn.provider_error ?? outputMsg?.content}</pre>
                          </div>
                        )}

                        {contextByTurn[turn.turn_id] && (
                          <div className="turn-section sensitive">
                            <details onClick={() => requestAnimationFrame(draw)}>
                              <summary>
                                <span className="sensitive-tag">敏感本机诊断</span>
                                实际模型输入 · 默认折叠
                              </summary>
                              <div className="model-input">
                                <ModelInput rendered={contextByTurn[turn.turn_id]} />
                              </div>
                            </details>
                          </div>
                        )}
                      </div>

                      {routeOut && (
                        <div className={`route-out route-${classifyArrow(turn, turn, routeEdges).kind}`}>
                          <span>系统路由</span>
                          <b>
                            {laneMap.get(routeOut.source_agent)?.name ?? routeOut.source_agent}
                            {' → '}
                            {laneMap.get(routeOut.target_agent)?.name ?? routeOut.target_agent}
                          </b>
                        </div>
                      )}
                    </article>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
