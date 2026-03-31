// ── Status constants ──────────────────────────────────────────────────────────

export const STATUS = {
  OPEN:                'open',
  IN_PROGRESS:         'in-progress',
  NEEDS_INPUT:         'needs-input',
  ADDRESSED:           'addressed',
  ADDRESSED_NO_CHANGE: 'addressed-no-change',
  APPROVED:            'approved',
  DISMISSED:           'dismissed',
  OUTDATED:            'outdated',
} as const;

export type CommentStatus = typeof STATUS[keyof typeof STATUS];

/** Statuses set by the user to close out a comment (no further agent action needed). */
export const CLOSED_STATUSES = new Set<CommentStatus>([STATUS.APPROVED, STATUS.DISMISSED]);
