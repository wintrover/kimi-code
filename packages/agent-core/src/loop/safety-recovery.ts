import type { ContentPart, Message, TextPart } from '@moonshot-ai/kosong';

// ---------------------------------------------------------------------------
// Public constants & types
// ---------------------------------------------------------------------------

export const MAX_SAFETY_RECOVERY_ATTEMPTS = 3;

export enum SafetyRecoveryStrategy {
  TOOL_OUTPUT_PRUNE = 'tool_output_prune',
  TURN_COMPRESS = 'turn_compress',
  CODE_ABSTRACT = 'code_abstract',
  GIVE_UP = 'give_up',
}

export interface SafetyRecoveryResult {
  readonly recovered: boolean;
  readonly prunedMessages?: readonly Message[];
  readonly strategy: SafetyRecoveryStrategy;
  readonly attempt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Estimate the text length of a message by summing all TextPart content. */
function estimateTextLength(message: Message): number {
  let len = 0;
  for (const part of message.content) {
    if (part.type === 'text') {
      len += (part as TextPart).text.length;
    }
  }
  return len;
}

// ---------------------------------------------------------------------------
// Strategy 1 — toolOutputPrune
// ---------------------------------------------------------------------------

function toolOutputPrune(messages: readonly Message[]): SafetyRecoveryResult {
  const windowSize = 6;
  const window = messages.slice(Math.max(0, messages.length - windowSize));

  const toolMessages = window.filter((m) => m.role === 'tool');
  if (toolMessages.length === 0) {
    return { recovered: false, strategy: SafetyRecoveryStrategy.TOOL_OUTPUT_PRUNE, attempt: 1 };
  }

  // Find the largest tool message by text length
  let largestIndex = -1;
  let largestLen = -1;
  for (let i = 0; i < toolMessages.length; i++) {
    const len = estimateTextLength(toolMessages[i]!);
    if (len > largestLen) {
      largestLen = len;
      largestIndex = i;
    }
  }

  const target = toolMessages[largestIndex]!;

  // Clone messages, replacing the target tool message's content
  const prunedMessages = messages.map((msg) => {
    if (msg !== target) return msg;
    return {
      ...msg,
      content: [{ type: 'text', text: '[Tool output redacted by safety recovery]' } as TextPart],
    };
  });

  return {
    recovered: true,
    prunedMessages,
    strategy: SafetyRecoveryStrategy.TOOL_OUTPUT_PRUNE,
    attempt: 1,
  };
}

// ---------------------------------------------------------------------------
// Strategy 2 — turnCompress
// ---------------------------------------------------------------------------

const TURN_COMPRESS_TOOL_REPLACEMENT = '[Turn content compressed by safety recovery]';
const TURN_COMPRESS_TRUNCATE_LEN = 200;

function turnCompress(messages: readonly Message[]): SafetyRecoveryResult {
  const windowSize = 8;
  const windowStart = Math.max(0, messages.length - windowSize);
  const window = messages.slice(windowStart);

  // Check if there are any assistant or tool messages in the window
  const hasTarget = window.some((m) => m.role === 'assistant' || m.role === 'tool');
  if (!hasTarget) {
    return { recovered: false, strategy: SafetyRecoveryStrategy.TURN_COMPRESS, attempt: 2 };
  }

  const prunedMessages = messages.map((msg, idx) => {
    // Only modify messages within the window
    if (idx < windowStart) return msg;

    if (msg.role === 'assistant') {
      // Truncate text content to first 200 chars, keep only TextPart
      const newContent: TextPart[] = [];
      for (const part of msg.content) {
        if (part.type === 'text') {
          const text = (part as TextPart).text;
          newContent.push({
            type: 'text',
            text: text.length > TURN_COMPRESS_TRUNCATE_LEN
              ? text.slice(0, TURN_COMPRESS_TRUNCATE_LEN)
              : text,
          });
        }
      }
      return { ...msg, content: newContent };
    }

    if (msg.role === 'tool') {
      return {
        ...msg,
        content: [{ type: 'text', text: TURN_COMPRESS_TOOL_REPLACEMENT } as TextPart],
      };
    }

    return msg;
  });

  return {
    recovered: true,
    prunedMessages,
    strategy: SafetyRecoveryStrategy.TURN_COMPRESS,
    attempt: 2,
  };
}

// ---------------------------------------------------------------------------
// Strategy 3 — codeAbstract
// ---------------------------------------------------------------------------

const CODE_BLOCK_RE = /```(\w*)\n([\s\S]*?)```/g;

function codeAbstract(messages: readonly Message[]): SafetyRecoveryResult {
  let foundCodeBlock = false;

  const prunedMessages = messages.map((msg) => {
    const newContent: ContentPart[] = [];
    for (const part of msg.content) {
      if (part.type !== 'text') {
        newContent.push(part);
        continue;
      }

      const text = (part as TextPart).text;
      // Reset regex state for each part
      CODE_BLOCK_RE.lastIndex = 0;
      if (!CODE_BLOCK_RE.test(text)) {
        newContent.push(part);
        continue;
      }

      foundCodeBlock = true;
      CODE_BLOCK_RE.lastIndex = 0;
      const replaced = text.replace(CODE_BLOCK_RE, (_match, lang: string, body: string) => {
        const lineCount = body.split('\n').length;
        return `[Code block redacted by safety recovery: ${lang}, ${lineCount} lines]`;
      });
      newContent.push({ type: 'text', text: replaced });
    }
    return { ...msg, content: newContent };
  });

  if (!foundCodeBlock) {
    return { recovered: false, strategy: SafetyRecoveryStrategy.CODE_ABSTRACT, attempt: 3 };
  }

  return {
    recovered: true,
    prunedMessages,
    strategy: SafetyRecoveryStrategy.CODE_ABSTRACT,
    attempt: 3,
  };
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

/**
 * Attempt to recover from a provider safety filter error by progressively
 * pruning the conversation context.
 *
 * @param messages - The current conversation messages.
 * @param attempt - The current attempt number (1-based).
 * @returns A result describing whether recovery was performed and the pruned messages.
 */
export function attemptSafetyRecovery(
  messages: readonly Message[],
  attempt: number,
): SafetyRecoveryResult {
  switch (attempt) {
    case 1:
      return toolOutputPrune(messages);
    case 2:
      return turnCompress(messages);
    case 3:
      return codeAbstract(messages);
    default:
      return {
        recovered: false,
        strategy: SafetyRecoveryStrategy.GIVE_UP,
        attempt,
      };
  }
}
