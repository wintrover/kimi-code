/**
 * Intent classifier service.
 *
 * Classifies user messages into intent categories for security routing.
 * Placeholder for the full intent classification implementation.
 */

export interface IntentClassification {
  readonly intent: string;
  readonly confidence: number;
  readonly category: string;
}

export interface IntentClassifierResult {
  readonly classifications: readonly IntentClassification[];
  readonly primaryIntent: string;
}

export interface IntentClassifierOptions {
  readonly modelAlias?: string;
  readonly threshold?: number;
}

/**
 * Service that classifies user intent from conversation context.
 */
export class IntentClassifierService {
  constructor(_options?: IntentClassifierOptions) {}

  async classify(_input: string): Promise<IntentClassifierResult> {
    return {
      classifications: [],
      primaryIntent: 'unknown',
    };
  }
}
