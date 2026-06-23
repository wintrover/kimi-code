import { randomBytes } from 'node:crypto';

import { RankingFunction } from './ranking';
import type { StateVector, TransitionProposal, TransitionValidationResult } from './ranking';
import { ContractGate } from './contract';
import type { VerificationResult } from './contract';
import { ProofSigner } from './proof';
import type { ProofArtifact, VerifiedTransition } from './proof';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StateVerifierOptions {
  /** HMAC secret for proof signing — host-side only, never exposed to agent. */
  readonly hmacSecret?: string;
  /** Invariant rules for the contract gate. */
  readonly invariants?: readonly string[];
  /** Maximum tool calls without progress before auto-rejection. */
  readonly maxToolCallsWithoutProgress?: number;
}

export interface VerifyResult {
  readonly accepted: boolean;
  readonly transition?: VerifiedTransition;
  readonly rejectionReason?: string;
  readonly rankingResult?: TransitionValidationResult;
  readonly contractResult?: VerificationResult;
}

// ---------------------------------------------------------------------------
// StateVerifier
// ---------------------------------------------------------------------------

/**
 * Unified verification pipeline that composes RankingFunction, ContractGate,
 * and ProofArtifact into a single decision point.
 *
 * Every proposed state transition must pass through this verifier before
 * the host runtime applies it. LLM is treated as a "non-deterministic
 * heuristic proposer"; this class is the "deterministic mathematical verifier".
 */
export class StateVerifier {
  private readonly ranking: RankingFunction;
  private readonly contractGate: ContractGate;
  private readonly signer: ProofSigner;
  private readonly historyHashes = new Set<string>();
  private lastGoodState: StateVector | null = null;

  constructor(options?: StateVerifierOptions) {
    this.ranking = new RankingFunction();
    this.contractGate = new ContractGate(
      [...(options?.invariants ?? [
        'taskCompletion must not decrease',
        'same state must not repeat',
      ])],
    );
    this.signer = new ProofSigner(
      options?.hmacSecret ?? randomBytes(32).toString('hex'),
    );
  }

  /**
   * Initialise the underlying contract gate (lazy, safe to call multiple times).
   */
  async init(): Promise<void> {
    await this.contractGate.init();
  }

  /**
   * Verify a proposed state transition through the full pipeline:
   *  1. Ranking Function — O(1) monotonicity + liveness check
   *  2. Contract Gate — Z3 SMT (or fallback) formal verification
   *  3. Proof Artifact — HMAC-signed, tamper-proof credential
   */
  async verify(proposal: TransitionProposal): Promise<VerifyResult> {
    // ---- Step 1: Ranking Function (O(1), native) ----
    const rankingResult = this.ranking.validateTransition(
      proposal.prevState,
      proposal.nextState,
    );
    if (!rankingResult.valid) {
      this.contractGate.rollback();
      return {
        accepted: false,
        rejectionReason: `[Ranking] ${rankingResult.reason}`,
        rankingResult,
      };
    }

    // ---- Step 1b: Structural hash duplicate detection ----
    const hash = this.ranking.structuralHash(proposal.actionDescription);
    if (this.historyHashes.has(hash)) {
      this.contractGate.rollback();
      return {
        accepted: false,
        rejectionReason: `[Ranking] semantic duplicate detected (hash: ${hash.slice(0, 12)}…)`,
        rankingResult,
      };
    }
    this.historyHashes.add(hash);

    // ---- Step 2: Contract Gate (Z3 SMT) ----
    const contractResult = await this.contractGate.verify(proposal);
    if (contractResult.status !== 'approved') {
      this.contractGate.rollback();
      return {
        accepted: false,
        rejectionReason: `[Contract] ${contractResult.status === 'rejected' ? contractResult.reason : 'verification timed out'}`,
        rankingResult,
        contractResult,
      };
    }

    // ---- Step 3: Proof Artifact (HMAC signed) ----
    const deltaMu =
      this.ranking.distance(proposal.nextState) -
      this.ranking.distance(proposal.prevState);

    const proofPayload = {
      transitionHash: hash,
      deltaMu,
      contractProof: { status: contractResult.status, proof: contractResult.proof },
      nonce: this.signer.nextNonce(),
    };

    const proof: ProofArtifact = {
      ...proofPayload,
      signature: this.signer.sign(proofPayload),
    };

    this.lastGoodState = proposal.nextState;

    return {
      accepted: true,
      transition: { ...proposal, proof },
      rankingResult,
      contractResult,
    };
  }

  /**
   * Roll back to the last known good state.
   */
  rollback(): StateVector | null {
    this.contractGate.rollback();
    return this.lastGoodState;
  }

  /**
   * Dispose of all resources.
   */
  dispose(): void {
    this.contractGate.dispose();
    this.historyHashes.clear();
  }
}
