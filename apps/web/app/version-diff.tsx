/**
 * 版本行级 diff · 标注 editable / frozen 行
 * 可编辑行（蓝）/ 冻结行（灰）/ 改动的冻结行（红=越界指示）
 * 受控返修（支柱三）可视化：一眼看出 generator 是否越界改了冻结行
 */

interface Props {
  before: string;
  after: string;
  changedLines: number[];
  editableLines: number[];
  frozenLines: number[];
}

export function VersionDiff({ before, after, changedLines, editableLines, frozenLines }: Props) {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const rows = Math.max(beforeLines.length, afterLines.length);
  const changedSet = new Set(changedLines);
  const editableSet = new Set(editableLines);
  const frozenSet = new Set(frozenLines);

  return (
    <div className="diff">
      <div className="diff-legend">
        <span className="legend-editable">editable</span>
        <span className="legend-frozen">frozen</span>
        <span className="legend-changed">changed</span>
        <span className="legend-violation">scope violation</span>
      </div>
      {Array.from({ length: rows }, (_, i) => {
        const lineNo = i + 1;
        const changed = changedSet.has(lineNo);
        const editable = editableSet.has(lineNo);
        const frozen = frozenSet.has(lineNo);
        const violation = changed && frozen;
        const cls = ['diff-row'];
        if (changed) cls.push('changed');
        if (violation) cls.push('violation');
        const lnCls = editable ? 'ln-editable' : frozen ? 'ln-frozen' : '';
        return (
          <div key={i} className={cls.join(' ')}>
            <b className={`diff-line-no ${lnCls} ${violation ? 'ln-violation' : ''}`}>{lineNo}</b>
            <del>{beforeLines[i] ?? ''}</del>
            <ins>{afterLines[i] ?? ''}</ins>
          </div>
        );
      })}
    </div>
  );
}
