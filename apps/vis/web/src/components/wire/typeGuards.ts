import type { CompactionResult } from '../../types';

/**
 * Type guard for full_compaction.complete events with valid CompactionResult data.
 * Returns false for legacy data (empty objects from older sessions).
 */
export function isCompactionCompleteWithSummary(
  event: { type: string },
): event is { type: 'full_compaction.complete' } & CompactionResult {
  return event.type === 'full_compaction.complete' && 'summary' in event;
}
