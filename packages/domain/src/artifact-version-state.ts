/**
 * 产物版本状态机
 * draft → under_review → approved → delivered
 * 其他：invalidated（被上游变更作废）、superseded（被新版本取代）、rejected（返修越界被拒）
 */

import type { ArtifactVersionStatus } from '@forge-ai/contracts';

const VALID_TRANSITIONS: Record<ArtifactVersionStatus, ArtifactVersionStatus[]> = {
  draft: ['under_review', 'invalidated', 'superseded'],
  under_review: ['approved', 'rejected', 'invalidated', 'superseded'],
  approved: ['delivered', 'superseded', 'invalidated'],
  delivered: [],
  invalidated: [],
  superseded: [],
  rejected: [],
};

export function canTransitionArtifactVersion(
  from: ArtifactVersionStatus,
  to: ArtifactVersionStatus,
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionArtifactVersion(
  from: ArtifactVersionStatus,
  to: ArtifactVersionStatus,
): ArtifactVersionStatus {
  if (!canTransitionArtifactVersion(from, to)) {
    throw new Error(`Invalid artifact version state transition: ${from} → ${to}`);
  }
  return to;
}
