import { describe, expect, it } from 'vitest';
import { descendantClosure } from './invalidation.js';

const records = [
  { record_id: 'outline-v1', parent_record_ids: [] },
  { record_id: 'packet-b001-v1', parent_record_ids: ['outline-v1'] },
  { record_id: 'draft-b001-v1', parent_record_ids: ['packet-b001-v1'] },
  { record_id: 'ledger-b001-v1', parent_record_ids: ['draft-b001-v1'] },
  { record_id: 'packet-b002-v1', parent_record_ids: ['outline-v1', 'ledger-b001-v1'] },
  { record_id: 'unrelated-v1', parent_record_ids: [] },
  {
    record_id: 'final-v1',
    parent_record_ids: ['outline-v1', 'draft-b001-v1', 'ledger-b001-v1'],
  },
];

describe('downstream invalidation propagation', () => {
  it('invalidates the rollback root and every dependent descendant', () => {
    expect(descendantClosure(records, 'packet-b001-v1')).toEqual([
      'packet-b001-v1',
      'draft-b001-v1',
      'ledger-b001-v1',
      'packet-b002-v1',
      'final-v1',
    ]);
  });

  it('preserves ancestors and unrelated branches', () => {
    const affected = descendantClosure(records, 'draft-b001-v1');
    expect(affected).not.toContain('outline-v1');
    expect(affected).not.toContain('packet-b001-v1');
    expect(affected).not.toContain('unrelated-v1');
  });

  it('does not append duplicate invalidations', () => {
    const affected = descendantClosure(
      records,
      'packet-b001-v1',
      new Set(['draft-b001-v1']),
    );
    expect(affected).not.toContain('draft-b001-v1');
    expect(affected).not.toContain('ledger-b001-v1');
    expect(affected).toContain('packet-b001-v1');
  });
});
