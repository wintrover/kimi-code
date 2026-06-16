import { createHmac } from 'node:crypto';

import type { TransitionProposal } from './ranking';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProofArtifact {
  /** Structural hash of the transition (from RankingFunction.structuralHash). */
  readonly transitionHash: string;
  /** Change in ranking-function distance (delta μ). */
  readonly deltaMu: number;
  /** Result of the contract verification. */
  readonly contractProof: { readonly status: string; readonly proof?: string };
  /** Monotonically-increasing nonce to prevent replay. */
  readonly nonce: number;
  /** HMAC-SHA256 signature over the payload fields. */
  readonly signature: string;
}

/** A TransitionProposal that has been verified and signed by the host. */
export type VerifiedTransition = TransitionProposal & { readonly proof: ProofArtifact };

// ---------------------------------------------------------------------------
// Proof Signer
// ---------------------------------------------------------------------------

/**
 * HMAC-based signer for proof artifacts.
 *
 * The secret key lives exclusively on the host side and is never exposed
 * to the agent process. Each {@link VerifiedTransition} carries a signature
 * that proves the host authorised the transition.
 */
export class ProofSigner {
  private readonly secret: string;
  private nonce = 0;

  constructor(secret: string) {
    this.secret = secret;
  }

  /** Creates an HMAC-SHA256 signature over the JSON-serialised payload. */
  sign(payload: object): string {
    const body = JSON.stringify(payload, Object.keys(payload).sort());
    return createHmac('sha256', this.secret).update(body).digest('hex');
  }

  /** Verifies an HMAC-SHA256 signature against the payload. */
  verify(payload: object, signature: string): boolean {
    const expected = this.sign(payload);
    return timingSafeEqual(expected, signature);
  }

  /** Returns the next nonce value (monotonically increasing). */
  nextNonce(): number {
    return ++this.nonce;
  }
}

// ---------------------------------------------------------------------------
// Type Guard
// ---------------------------------------------------------------------------

/**
 * Type guard that checks whether `value` is a fully-formed
 * {@link VerifiedTransition} with a valid HMAC signature.
 */
export function isVerified(
  value: unknown,
  signer: ProofSigner,
): value is VerifiedTransition {
  if (value === null || typeof value !== 'object') return false;

  const obj = value as Record<string, unknown>;

  // Required TransitionProposal fields.
  if (!isStateVector(obj['prevState']) || !isStateVector(obj['nextState'])) return false;
  if (typeof obj['actionDescription'] !== 'string') return false;
  if (typeof obj['timestamp'] !== 'number') return false;

  // Required ProofArtifact fields.
  const proof = obj['proof'];
  if (proof === null || typeof proof !== 'object') return false;
  const p = proof as Record<string, unknown>;
  if (typeof p['transitionHash'] !== 'string') return false;
  if (typeof p['deltaMu'] !== 'number') return false;
  if (p['contractProof'] === null || typeof p['contractProof'] !== 'object') return false;
  if (typeof p['nonce'] !== 'number') return false;
  if (typeof p['signature'] !== 'string') return false;

  // Verify HMAC signature.
  const payload = {
    transitionHash: p['transitionHash'],
    deltaMu: p['deltaMu'],
    contractProof: p['contractProof'],
    nonce: p['nonce'],
  };
  if (!signer.verify(payload, p['signature'] as string)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Thrown when a proof artifact is required but missing or invalid.
 */
export class ProofRequiredError extends Error {
  constructor(message?: string) {
    super(message ?? 'valid proof artifact is required');
    this.name = 'ProofRequiredError';
  }
}

// ---------------------------------------------------------------------------
// Helpers (module-private)
// ---------------------------------------------------------------------------

function isStateVector(
  v: unknown,
): v is {
  taskCompletion: number;
  uniqueInsights: number;
  toolCallsSinceProgress: number;
  errorRecoveryAttempts: number;
} {
  if (v === null || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s['taskCompletion'] === 'number' &&
    typeof s['uniqueInsights'] === 'number' &&
    typeof s['toolCallsSinceProgress'] === 'number' &&
    typeof s['errorRecoveryAttempts'] === 'number'
  );
}

/**
 * Constant-time string comparison to avoid timing side-channels.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
