/**
 * `/security-log` slash command handler.
 *
 * Displays the security audit summary in the transcript using a bordered panel.
 * Supports `--rule-id <pattern>` and `--since <ISO date>` filters.
 */

import {
  SecurityAuditLogger,
} from '@moonshot-ai/kimi-code-sdk';

import {
  SecurityDashboardComponent,
  buildSecuritySummaryLines,
  parseSecurityLogArgs,
} from '../components/security-dashboard';
import type { SlashCommandHost } from './dispatch';

export function handleSecurityLogCommand(
  host: SlashCommandHost,
  args: string,
): void {
  const parsed = parseSecurityLogArgs(args);
  const logger = new SecurityAuditLogger();

  const panel = new SecurityDashboardComponent(() => {
    const events = logger.getRecentEvents();
    return buildSecuritySummaryLines(events, parsed);
  });
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}
