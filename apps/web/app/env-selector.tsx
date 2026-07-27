'use client';

/**
 * 顶部 env 选择器（生产 / 测试 / 全部）。
 * 切换改 URL ?env=，并清掉 case 选择（不同库的 case 不同）。全局可见，放 topbar 右侧。
 */

import type { ChangeEvent } from 'react';

const ENV_OPTIONS = [
  { value: 'production', label: '生产' },
  { value: 'test', label: '测试' },
  { value: 'all', label: '全部' },
] as const;

export function EnvSelector({ currentEnv }: { currentEnv: string }) {
  function onChange(e: ChangeEvent<HTMLSelectElement>) {
    // 切 env 时清掉 case 选择（不同库的 case 不同），整页重载取新列表
    window.location.href = `/?env=${e.target.value}`;
  }

  return (
    <label className="env-selector">
      <span className="env-label">库</span>
      <select
        value={currentEnv}
        onChange={onChange}
        className="env-select"
        aria-label="选择数据库环境"
      >
        {ENV_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}
