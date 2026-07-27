export interface DependencyRecord {
  record_id: string;
  parent_record_ids: string[];
}

export function descendantClosure(
  records: DependencyRecord[],
  rootRecordId: string,
  alreadyInvalidated: ReadonlySet<string> = new Set(),
): string[] {
  const known = new Set(records.map((record) => record.record_id));
  if (!known.has(rootRecordId)) throw new Error(`未知回退根产物: ${rootRecordId}`);
  const affected = new Set<string>();
  if (!alreadyInvalidated.has(rootRecordId)) affected.add(rootRecordId);

  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (alreadyInvalidated.has(record.record_id) || affected.has(record.record_id)) continue;
      if (record.parent_record_ids.some((parentId) => affected.has(parentId))) {
        affected.add(record.record_id);
        changed = true;
      }
    }
  }
  return records
    .filter((record) => affected.has(record.record_id))
    .map((record) => record.record_id);
}
