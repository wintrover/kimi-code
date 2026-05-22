import type { WireRecordType } from '../../types';
import { Pill } from '../shared/Pill';
import { TYPE_ICON, TYPE_TONE } from './typeMeta';

interface TypeBadgeProps {
  type: WireRecordType;
}

export function TypeBadge({ type }: TypeBadgeProps) {
  const icon = TYPE_ICON[type];
  const tone = TYPE_TONE[type];
  return (
    <Pill tone={tone} variant="soft">
      <span className="tabular" aria-hidden="true">
        {icon}
      </span>
      <span>{type}</span>
    </Pill>
  );
}
