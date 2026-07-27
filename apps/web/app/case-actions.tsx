'use client';

import { useState, useEffect, useCallback } from 'react';

interface TemplateInfo {
  name: string;
  path: string;
}

interface InputField {
  key: string;
  label: string;
}

export function CaseActions({ caseId, caseStatus, env, caseDbPath }: { caseId?: string; caseStatus?: string; env: string; caseDbPath?: string }) {
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [inputFields, setInputFields] = useState<InputField[]>([]);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // resume 相关
  const [resumeAnswer, setResumeAnswer] = useState('');
  const [resumeLoading, setResumeLoading] = useState(false);

  // 写操作必须单库（production|test）；all 为只读聚合视图，禁用写按钮。
  const isReadOnly = env === 'all';

  // 加载模板列表
  useEffect(() => {
    fetch('/api/template/list')
      .then((r) => r.json())
      .then((data) => {
        if (data.templates) setTemplates(data.templates);
      })
      .catch(() => {});
  }, []);

  // 选模板后加载 input_fields（动态获取）
  const loadTemplateFields = useCallback(async (name: string) => {
    if (!name) {
      setInputFields([]);
      return;
    }
    try {
      const res = await fetch(`/api/template/show?name=${encodeURIComponent(name)}`);
      const data = await res.json();
      if (res.ok && Array.isArray(data.input_fields)) {
        setInputFields(data.input_fields.map((f: { key: string; label: string }) => ({ key: f.key, label: f.label })));
      } else {
        setInputFields([]);
      }
      setFieldValues({});
    } catch {
      setInputFields([]);
    }
  }, []);

  const handleTemplateChange = (name: string) => {
    setSelectedTemplate(name);
    setError('');
    setSuccess('');
    loadTemplateFields(name);
  };

  // 创建 + 运行 case
  const handleCreateAndRun = async () => {
    if (isReadOnly) return; // all 视图只读，写按钮已禁用（防御）
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      // 1. create（带 env，写操作必须单库；create 后落在 env 对应的库）
      const createRes = await fetch('/api/case/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: selectedTemplate, input: fieldValues, env }),
      });
      const createData = await createRes.json();
      if (!createRes.ok || createData.error) {
        setError(createData.error ?? 'Create failed');
        setLoading(false);
        return;
      }

      const newCaseId = createData.case_id;

      // 2. run（带 env，定位到刚创建的库）
      const runRes = await fetch('/api/case/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId: newCaseId, env }),
      });
      const runData = await runRes.json();
      if (!runRes.ok || runData.error) {
        setError(runData.error ?? 'Run failed');
        if (runData.blocking_case_id) {
          setError(`被阻塞：${runData.blocking_case_id} 正在运行`);
        }
        setLoading(false);
        return;
      }

      setSuccess(`Case ${newCaseId} 已启动`);
      // 跳转到新 case，保留 env（写操作 env 必为单库）
      setTimeout(() => {
        window.location.href = `/?env=${env}&case=${newCaseId}`;
      }, 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  // resume
  const handleResume = async () => {
    if (!caseId || !resumeAnswer.trim()) return;
    setResumeLoading(true);
    setError('');
    setSuccess('');
    try {
      // env 单库时透传 env；all 视图下用选中 Case 的 dbPath 精确定位库（--db 优先级最高）。
      const res = await fetch('/api/case/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId, answer: resumeAnswer.trim(), env, dbPath: caseDbPath }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error ?? 'Resume failed');
        if (data.blocking_case_id) {
          setError(`被阻塞：${data.blocking_case_id} 正在运行`);
        }
      } else {
        setSuccess('已提交人工输入，Case 恢复运行');
        setResumeAnswer('');
        setTimeout(() => window.location.reload(), 1500);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setResumeLoading(false);
    }
  };

  return (
    <div className="case-actions">
      {/* 新建 Case 区域 */}
      <div className="action-panel">
        <h4>新建生产任务</h4>
        <div className="action-row">
          <select
            value={selectedTemplate}
            onChange={(e) => handleTemplateChange(e.target.value)}
            className="action-select"
          >
            <option value="">选择模板…</option>
            {templates.map((t) => (
              <option key={t.name} value={t.name}>{t.name}</option>
            ))}
          </select>
        </div>

        {inputFields.length > 0 && (
          <div className="action-fields">
            {inputFields.map((f) => (
              <div key={f.key} className="action-field">
                <label>{f.label}</label>
                <input
                  type="text"
                  value={fieldValues[f.key] ?? ''}
                  onChange={(e) => setFieldValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder={f.label}
                />
              </div>
            ))}
          </div>
        )}

        <button
          className="action-btn primary"
          disabled={!selectedTemplate || loading || isReadOnly}
          onClick={handleCreateAndRun}
          title={isReadOnly ? '全部视图为只读，请切换到生产或测试库后再创建任务' : undefined}
        >
          {loading ? '启动中…' : '创建并运行'}
        </button>
        {isReadOnly && (
          <small className="action-readonly-note">「全部」为只读聚合视图，无法创建任务。请切换到「生产」或「测试」库。</small>
        )}
      </div>

      {/* Resume 区域 —— 仅 waiting_human 时显示 */}
      {caseStatus === 'waiting_human' && caseId && (
        <div className="action-panel resume-panel">
          <h4>人工输入</h4>
          <div className="action-row resume-row">
            <input
              type="text"
              className="resume-input"
              value={resumeAnswer}
              onChange={(e) => setResumeAnswer(e.target.value)}
              placeholder="输入回答…"
              onKeyDown={(e) => { if (e.key === 'Enter') handleResume(); }}
            />
            <button
              className="action-btn"
              disabled={!resumeAnswer.trim() || resumeLoading}
              onClick={handleResume}
            >
              {resumeLoading ? '提交中…' : '提交'}
            </button>
          </div>
        </div>
      )}

      {/* 状态消息 */}
      {error && <div className="action-msg error">{error}</div>}
      {success && <div className="action-msg success">{success}</div>}
    </div>
  );
}
