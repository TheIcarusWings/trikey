import type { ActivityResult } from '@/api';
import { Badge } from '@/components/ui/badge';

const LABELS: Record<ActivityResult, string> = {
  'co-signed': 'Co-signed',
  refused: 'Refused',
  locked: 'Locked',
  ok: 'OK',
  'rule-changed': 'Rule changed',
};

export function ResultBadge({ result }: { result: ActivityResult }) {
  const variant = result === 'refused' ? 'destructive' : result === 'locked' ? 'warning' : 'outline';
  return <Badge variant={variant}>{LABELS[result]}</Badge>;
}
