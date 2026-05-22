import type { AnnotatedMessage } from '../../types';
import { Pill } from '../shared/Pill';

interface EphemeralBubbleProps {
  message: AnnotatedMessage;
}

/**
 * Ephemeral-injected message (system_reminder or notification).
 * Rendered with dashed border + inset — unambiguous signal that this
 * is NOT a real user turn.
 */
export function EphemeralBubble({ message }: EphemeralBubbleProps) {
  const { origin } = message;
  if (origin.kind === 'system_reminder') {
    return <SystemReminderBubble m={message} />;
  }
  if (origin.kind === 'notification') {
    return <NotificationBubble m={message} severity={origin.severity} />;
  }
  return null;
}

function SystemReminderBubble({ m }: { m: AnnotatedMessage }) {
  const text = extractText(m);
  // Strip XML wrapper for display (show just the inner content)
  const inner = text
    .replace(/^\s*<system-reminder>\n?/, '')
    .replace(/\n?<\/system-reminder>\s*$/, '');

  return (
    <article
      className={[
        'ml-4 flex max-w-full min-w-0 flex-col bg-surface-2 px-3 py-2',
        'ephemeral-border',
        m.out_of_context ? 'opacity-50' : '',
      ].join(' ')}
    >
      <header className="mb-1 flex items-center gap-2">
        <Pill tone="ephemeral" variant="solid">system_reminder</Pill>
        <span className="font-mono text-[10px] text-fg-3 tabular">
          injected @ seq {m.seq}
        </span>
      </header>
      <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-[1.55] text-fg-1">
        {inner}
      </pre>
    </article>
  );
}

function NotificationBubble({ m, severity }: { m: AnnotatedMessage; severity: string }) {
  const text = extractText(m);
  // Strip <notification ...> wrapper
  const inner = text
    .replace(/^\s*<notification[^>]*>\n?/, '')
    .replace(/\n?<\/notification>\s*$/, '');
  const tone =
    severity === 'error'
      ? 'error'
      : severity === 'warning'
        ? 'warning'
        : severity === 'success'
          ? 'success'
          : 'info';
  const borderClass =
    severity === 'error'
      ? 'ephemeral-border-error'
      : severity === 'warning'
        ? 'ephemeral-border-warning'
        : severity === 'success'
          ? 'ephemeral-border-success'
          : 'ephemeral-border-info';

  return (
    <article
      className={[
        'ml-4 flex max-w-full min-w-0 flex-col bg-surface-2 px-3 py-2',
        'ephemeral-border',
        borderClass,
        m.out_of_context ? 'opacity-50' : '',
      ].join(' ')}
    >
      <header className="mb-1 flex items-center gap-2">
        <Pill tone="meta" variant="solid">notification</Pill>
        <Pill tone={tone} variant="soft">{severity}</Pill>
        <span className="font-mono text-[10px] text-fg-3 tabular">
          injected @ seq {m.seq}
        </span>
      </header>
      <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-[1.55] text-fg-1">
        {inner}
      </pre>
    </article>
  );
}

function extractText(m: AnnotatedMessage): string {
  const p = m.message.content.find((x) => x.type === 'text');
  return p ? ((p['text'] as string | undefined) ?? '') : '';
}
