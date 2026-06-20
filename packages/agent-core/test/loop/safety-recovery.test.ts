import type { Message } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import {
  MAX_SAFETY_RECOVERY_ATTEMPTS,
  SafetyRecoveryStrategy,
  attemptSafetyRecovery,
} from '#/loop/safety-recovery';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function userMsg(text: string): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}

function assistantMsg(text: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}

function toolMsg(toolCallId: string, text: string): Message {
  return {
    role: 'tool',
    content: [{ type: 'text', text }],
    toolCalls: [],
    toolCallId,
  };
}

function systemMsg(text: string): Message {
  return {
    role: 'system',
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('attemptSafetyRecovery', () => {
  // --- Strategy 1: toolOutputPrune ---

  describe('toolOutputPrune (attempt 1)', () => {
    it('prunes the largest recent tool message', () => {
      const messages: Message[] = [
        userMsg('Hello'),
        toolMsg('tc1', 'short'),
        toolMsg('tc2', 'x'.repeat(500)),
        toolMsg('tc3', 'medium output'),
        assistantMsg('Response'),
      ];

      const result = attemptSafetyRecovery(messages, 1);

      expect(result.recovered).toBe(true);
      expect(result.strategy).toBe(SafetyRecoveryStrategy.TOOL_OUTPUT_PRUNE);
      expect(result.attempt).toBe(1);
      expect(result.prunedMessages).toBeDefined();

      const pruned = result.prunedMessages!;
      // The largest tool message (tc2 with 500 chars) should be redacted
      expect(pruned[2]!.content).toEqual([
        { type: 'text', text: '[Tool output redacted by safety recovery]' },
      ]);
      // Other messages should be unchanged
      expect(pruned[0]!.content).toEqual([{ type: 'text', text: 'Hello' }]);
      expect(pruned[1]!.content).toEqual([{ type: 'text', text: 'short' }]);
    });

    it('returns recovered=false when no tool messages in window', () => {
      const messages: Message[] = [
        userMsg('Hello'),
        assistantMsg('Hi there'),
        userMsg('How are you?'),
      ];

      const result = attemptSafetyRecovery(messages, 1);

      expect(result.recovered).toBe(false);
      expect(result.strategy).toBe(SafetyRecoveryStrategy.TOOL_OUTPUT_PRUNE);
      expect(result.prunedMessages).toBeUndefined();
    });

    it('only considers the last 6 messages for tool pruning', () => {
      // Put a large tool message outside the window (position 0 of 8 messages)
      const largeTool = 'Y'.repeat(1000);
      const messages: Message[] = [
        toolMsg('tc-old', largeTool),
        userMsg('m1'),
        assistantMsg('m2'),
        userMsg('m3'),
        assistantMsg('m4'),
        userMsg('m5'),
        assistantMsg('m6'),
        userMsg('m7'),
      ];

      const result = attemptSafetyRecovery(messages, 1);

      // No tool messages in the last 6 → recovered=false
      expect(result.recovered).toBe(false);
    });
  });

  // --- Strategy 2: turnCompress ---

  describe('turnCompress (attempt 2)', () => {
    it('truncates assistant messages and replaces tool messages', () => {
      const longText = 'A'.repeat(500);
      const messages: Message[] = [
        userMsg('Start'),
        assistantMsg(longText),
        toolMsg('tc1', 'Tool result data'),
        assistantMsg('Short'),
      ];

      const result = attemptSafetyRecovery(messages, 2);

      expect(result.recovered).toBe(true);
      expect(result.strategy).toBe(SafetyRecoveryStrategy.TURN_COMPRESS);
      expect(result.prunedMessages).toBeDefined();

      const pruned = result.prunedMessages!;

      // First assistant message should be truncated to 200 chars
      const firstAssistantText = (pruned[1]!.content[0] as { type: 'text'; text: string }).text;
      expect(firstAssistantText).toBe('A'.repeat(200));
      expect(firstAssistantText.length).toBe(200);

      // Tool message should be replaced
      expect(pruned[2]!.content).toEqual([
        { type: 'text', text: '[Turn content compressed by safety recovery]' },
      ]);

      // Short assistant message should remain intact (under 200 chars)
      const secondAssistantText = (pruned[3]!.content[0] as { type: 'text'; text: string }).text;
      expect(secondAssistantText).toBe('Short');

      // User message should be untouched
      expect(pruned[0]!.content).toEqual([{ type: 'text', text: 'Start' }]);
    });

    it('returns recovered=false when no assistant/tool messages in window', () => {
      const messages: Message[] = [
        userMsg('First'),
        userMsg('Second'),
        userMsg('Third'),
        userMsg('Fourth'),
      ];

      const result = attemptSafetyRecovery(messages, 2);

      expect(result.recovered).toBe(false);
      expect(result.strategy).toBe(SafetyRecoveryStrategy.TURN_COMPRESS);
    });

    it('only compresses messages in the last 8', () => {
      // 9 messages — message at index 0 should be preserved
      const earlyAssistant = 'E'.repeat(300);
      const messages: Message[] = [
        assistantMsg(earlyAssistant),
        userMsg('1'),
        assistantMsg('2'),
        userMsg('3'),
        assistantMsg('4'),
        userMsg('5'),
        assistantMsg('6'),
        userMsg('7'),
        assistantMsg('8'),
      ];

      const result = attemptSafetyRecovery(messages, 2);
      expect(result.recovered).toBe(true);

      const pruned = result.prunedMessages!;
      // Index 0 is outside the last 8 — should be untouched
      expect((pruned[0]!.content[0] as { type: 'text'; text: string }).text).toBe(earlyAssistant);
    });
  });

  // --- Strategy 3: codeAbstract ---

  describe('codeAbstract (attempt 3)', () => {
    it('replaces code blocks with redacted markers', () => {
      const messages: Message[] = [
        userMsg('Show me code'),
        assistantMsg(
          'Here is some code:\n```typescript\nconst x = 1;\nconst y = 2;\nconst z = 3;\n```\nDone.',
        ),
      ];

      const result = attemptSafetyRecovery(messages, 3);

      expect(result.recovered).toBe(true);
      expect(result.strategy).toBe(SafetyRecoveryStrategy.CODE_ABSTRACT);
      expect(result.prunedMessages).toBeDefined();

      const pruned = result.prunedMessages!;
      const text = (pruned[1]!.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('[Code block redacted by safety recovery: typescript, 4 lines]');
      expect(text).not.toContain('const x');
    });

    it('returns recovered=false when no code blocks found', () => {
      const messages: Message[] = [
        userMsg('Hello'),
        assistantMsg('No code here, just plain text.'),
      ];

      const result = attemptSafetyRecovery(messages, 3);

      expect(result.recovered).toBe(false);
      expect(result.strategy).toBe(SafetyRecoveryStrategy.CODE_ABSTRACT);
    });

    it('handles multiple code blocks across messages', () => {
      const messages: Message[] = [
        assistantMsg('```python\nprint("hello")\n```\n\n```js\nconsole.log("hi")\n```'),
      ];

      const result = attemptSafetyRecovery(messages, 3);
      expect(result.recovered).toBe(true);

      const text = (result.prunedMessages![0]!.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('[Code block redacted by safety recovery: python, 2 lines]');
      expect(text).toContain('[Code block redacted by safety recovery: js, 2 lines]');
    });
  });

  // --- Dispatcher ---

  describe('dispatch', () => {
    it('dispatches correctly by attempt number', () => {
      const messages: Message[] = [
        toolMsg('tc1', 'result'),
        assistantMsg('```js\ncode\n```'),
      ];

      const r1 = attemptSafetyRecovery(messages, 1);
      expect(r1.strategy).toBe(SafetyRecoveryStrategy.TOOL_OUTPUT_PRUNE);

      const r2 = attemptSafetyRecovery(messages, 2);
      expect(r2.strategy).toBe(SafetyRecoveryStrategy.TURN_COMPRESS);

      const r3 = attemptSafetyRecovery(messages, 3);
      expect(r3.strategy).toBe(SafetyRecoveryStrategy.CODE_ABSTRACT);
    });

    it('returns give_up for attempt > 3', () => {
      const messages: Message[] = [userMsg('Hello')];

      const result = attemptSafetyRecovery(messages, 4);
      expect(result.recovered).toBe(false);
      expect(result.strategy).toBe(SafetyRecoveryStrategy.GIVE_UP);
      expect(result.attempt).toBe(4);
    });

    it('returns give_up for attempt 0 or negative', () => {
      const messages: Message[] = [userMsg('Hello')];

      const r0 = attemptSafetyRecovery(messages, 0);
      expect(r0.strategy).toBe(SafetyRecoveryStrategy.GIVE_UP);

      const rNeg = attemptSafetyRecovery(messages, -1);
      expect(rNeg.strategy).toBe(SafetyRecoveryStrategy.GIVE_UP);
    });
  });

  // --- Readonly safety ---

  describe('message immutability', () => {
    it('does not mutate the original messages array', () => {
      const toolContent = [{ type: 'text' as const, text: 'original tool output' }];
      const messages: Message[] = [
        userMsg('Start'),
        assistantMsg('```rust\nfn main() {}\n```'),
        toolMsg('tc1', 'tool data'),
      ];
      // Capture original references
      const originalUserContent = messages[0]!.content;
      const originalAssistantContent = messages[1]!.content;
      const originalToolContent = messages[2]!.content;

      // Run all three strategies
      attemptSafetyRecovery(messages, 1);
      attemptSafetyRecovery(messages, 2);
      attemptSafetyRecovery(messages, 3);

      // Original content references should be unchanged
      expect(messages[0]!.content).toBe(originalUserContent);
      expect(messages[1]!.content).toBe(originalAssistantContent);
      expect(messages[2]!.content).toBe(originalToolContent);
    });

    it('does not mutate individual message objects', () => {
      const toolMessage = toolMsg('tc1', 'sensitive data here');
      const messages: Message[] = [toolMessage];

      const result = attemptSafetyRecovery(messages, 1);
      expect(result.recovered).toBe(true);

      // Original tool message content should still be the original text
      expect(toolMessage.content[0]).toEqual({ type: 'text', text: 'sensitive data here' });
    });
  });
});
