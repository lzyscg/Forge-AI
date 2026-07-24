/**
 * 只读回放页面
 * 轮询刷新（不做 SSE）
 */

import { getCases, getMessages, getArtifactVersions, getIssues, getDeliveryGateResults } from '../lib/db';
import type { CaseRecord, MessageRecord, ArtifactVersionRecord, IssueRecord, DeliveryGateResultRecord } from '../lib/db';
import { AutoRefresh } from './auto-refresh';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: { case?: string };
}

export default function Home({ searchParams }: PageProps) {
  const cases = getCases();
  const selectedCaseId = searchParams.case ?? cases[0]?.case_id;
  const selectedCase = selectedCaseId ? cases.find(c => c.case_id === selectedCaseId) : null;

  const messages: MessageRecord[] = selectedCaseId ? getMessages(selectedCaseId) : [];
  const versions: ArtifactVersionRecord[] = selectedCaseId ? getArtifactVersions(selectedCaseId) : [];
  const issues: IssueRecord[] = selectedCaseId ? getIssues(selectedCaseId) : [];
  const gateResults: DeliveryGateResultRecord[] = selectedCaseId ? getDeliveryGateResults(selectedCaseId) : [];

  return (
    <div className="container">
      <h1>🔨 Forge AI 回放</h1>

      {/* Case 列表 */}
      <section>
        <h2>Cases</h2>
        <div className="grid">
          {cases.map(c => (
            <a key={c.case_id} href={`/?case=${c.case_id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="card" style={{ border: c.case_id === selectedCaseId ? '2px solid #1976d2' : undefined }}>
                <div className="card-header">
                  <strong>{c.title}</strong>
                  <span className={`badge badge-${c.status}`}>{c.status}</span>
                </div>
                <small style={{ color: '#666' }}>{c.case_id}</small>
              </div>
            </a>
          ))}
        </div>
      </section>

      {selectedCase && (
        <>
          {/* 消息流 */}
          <section>
            <h2>消息流</h2>
            {messages.map(m => (
              <div key={m.message_id} className="card">
                <div className="card-header">
                  <span className="agent-tag">
                    {m.source_agent ?? 'system'} → {m.target_agent ?? 'all'}
                  </span>
                  <small style={{ color: '#999' }}>{m.message_type}</small>
                </div>
                <div className="message-content">{m.content}</div>
              </div>
            ))}
          </section>

          {/* 产物版本 */}
          <section>
            <h2>产物版本</h2>
            {versions.map(v => (
              <div key={v.artifact_version_id} className="card">
                <div className="card-header">
                  <strong>v{v.version}</strong>
                  <span className={`badge badge-${v.status}`}>{v.status}</span>
                </div>
                <div className="message-content">{v.content}</div>
                <small style={{ color: '#666', display: 'block', marginTop: 8 }}>
                  {v.summary}
                </small>
                {v.diff && (
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ cursor: 'pointer', color: '#1976d2' }}>查看 Diff</summary>
                    <pre style={{ fontSize: '0.8rem', background: '#f8f8f8', padding: 8, borderRadius: 4, overflow: 'auto' }}>
                      {v.diff}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </section>

          {/* Issues */}
          <section>
            <h2>Issues</h2>
            {issues.length === 0 ? (
              <p style={{ color: '#666' }}>无 Issue</p>
            ) : (
              issues.map(i => (
                <div key={i.issue_id} className={`card issue-item ${i.severity === 'blocking' ? 'issue-blocking' : ''}`}>
                  <div className="card-header">
                    <span className={`badge badge-${i.status}`}>{i.status}</span>
                    <span className="agent-tag">{i.severity}</span>
                  </div>
                  <div><strong>问题：</strong>{i.problem}</div>
                  <div><strong>锚点：</strong>{i.anchor}</div>
                  <div><strong>证据：</strong>{i.evidence}</div>
                </div>
              ))
            )}
          </section>

          {/* 交付门禁 */}
          <section>
            <h2>交付门禁</h2>
            {gateResults.length === 0 ? (
              <p style={{ color: '#666' }}>无门禁记录</p>
            ) : (
              gateResults.map(g => {
                const checks = JSON.parse(g.checks) as { name: string; passed: boolean; detail?: string }[];
                return (
                  <div key={g.result_id} className="card">
                    <div className="card-header">
                      <strong>{g.gate_passed ? '✅ 通过' : '❌ 未通过'}</strong>
                      <small style={{ color: '#999' }}>{g.created_at}</small>
                    </div>
                    {checks.map((c, idx) => (
                      <div key={idx} className={`gate-check ${c.passed ? 'gate-pass' : 'gate-fail'}`}>
                        <span>{c.passed ? '✓' : '✗'}</span>
                        <span>{c.name}</span>
                        {c.detail && <small style={{ color: '#666' }}>({c.detail})</small>}
                      </div>
                    ))}
                  </div>
                );
              })
            )}
          </section>
        </>
      )}

      {/* 自动刷新 */}
      <AutoRefresh interval={5000} />
      <p style={{ color: '#999', fontSize: '0.8rem', marginTop: 20, textAlign: 'center' }}>
        页面每 5 秒自动刷新
      </p>
    </div>
  );
}
