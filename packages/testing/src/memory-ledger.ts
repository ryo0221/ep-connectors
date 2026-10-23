import type {
  AttemptRecord,
  ClaimInput,
  ClaimResult,
  FencedWrite,
  NotDispatchedEvidence,
  OperationLedger,
  OperationRecord,
  StepAcquisition,
  StepRecord,
  StepResultRecord,
  UnresolvedStep,
} from '@ep-connectors/core';
import { SETTLED_STEP_STATES, UNRESOLVED_STEP_STATES } from '@ep-connectors/core';

interface MutableStep {
  state: StepRecord['state'];
  generation: number;
  attempts: AttemptRecord[];
  result?: StepResultRecord;
  /** 現在の fencing token と、その token が送信権か照合権か。 */
  fence: { token: string; mode: 'send' | 'reconcile' } | null;
  /** 直近の送信権のもとで試行を追記したか。`attempt-not-recorded` の証拠を確かめるのに使う。 */
  attemptedSinceAcquire: boolean;
}

interface MutableOperation {
  operation: string;
  slot: string;
  planDigest: string;
  plan: OperationRecord['plan'];
  steps: Map<string, MutableStep>;
}

/** 試験用の保管。各操作は await を挟まずに読んで書くため、単一の event loop の中で atomic になる。 */
export interface MemoryLedgerBacking {
  operations: Map<string, MutableOperation>;
  slots: Map<string, string>;
}

export function createLedgerBacking(): MemoryLedgerBacking {
  return { operations: new Map(), slots: new Map() };
}

/** 試験専用の `OperationLedger`。耐久性はなく、本番の Host へ「耐久性あり」と宣言させない。 */
export class MemoryLedger implements OperationLedger {
  constructor(private readonly backing: MemoryLedgerBacking) {}

  async claim(input: ClaimInput): Promise<ClaimResult> {
    const existing = this.backing.operations.get(input.operation);
    if (existing) {
      return existing.planDigest === input.planDigest && existing.slot === input.slot
        ? { kind: 'existing', operation: existing.operation }
        : { kind: 'conflict' };
    }
    const holder = this.backing.slots.get(input.slot);
    if (holder) return { kind: 'existing', operation: holder };
    this.backing.slots.set(input.slot, input.operation);
    this.backing.operations.set(input.operation, {
      operation: input.operation,
      slot: input.slot,
      planDigest: input.planDigest,
      plan: structuredClone(input.plan),
      steps: new Map(
        input.steps.map((step) => [
          step,
          {
            state: 'prepared',
            generation: 0,
            attempts: [],
            fence: null,
            attemptedSinceAcquire: false,
          } satisfies MutableStep,
        ]),
      ),
    });
    return { kind: 'claimed' };
  }

  async read(operation: string): Promise<OperationRecord | null> {
    const record = this.backing.operations.get(operation);
    if (!record) return null;
    const steps: Record<string, StepRecord> = {};
    for (const [name, step] of record.steps) {
      steps[name] = structuredClone({
        state: step.state,
        generation: step.generation,
        attempts: step.attempts,
        ...(step.result ? { result: step.result } : {}),
      });
    }
    return {
      operation: record.operation,
      slot: record.slot,
      planDigest: record.planDigest,
      plan: structuredClone(record.plan),
      steps,
    };
  }

  async acquireStep(
    operation: string,
    step: string,
    expectedGeneration: number,
  ): Promise<StepAcquisition> {
    const record = this.step(operation, step);
    if (!record) return { kind: 'not-acquired', state: 'conflict', generation: -1 };
    if (record.state !== 'prepared' || record.generation !== expectedGeneration) {
      return { kind: 'not-acquired', state: record.state, generation: record.generation };
    }
    record.attemptedSinceAcquire = false;
    return this.advance(operation, step, record, 'send', 'dispatching');
  }

  async appendAttempt(
    operation: string,
    attempt: AttemptRecord,
    fence: string,
  ): Promise<FencedWrite> {
    const record = this.step(operation, attempt.step);
    if (!record) return { ok: false, reason: 'unknown-step' };
    if (record.fence?.token !== fence || record.fence.mode !== 'send') {
      return { ok: false, reason: 'stale-fence' };
    }
    record.attempts.push(structuredClone(attempt));
    record.attemptedSinceAcquire = true;
    return { ok: true };
  }

  async recordResult(
    operation: string,
    step: string,
    result: StepResultRecord,
    fence: string,
  ): Promise<FencedWrite> {
    const record = this.step(operation, step);
    if (!record) return { ok: false, reason: 'unknown-step' };
    if (record.fence?.token !== fence) return { ok: false, reason: 'stale-fence' };
    record.state = result.state;
    record.result = structuredClone(result);
    // 確定した状態と `unknown` では権利を持ち越さない。`unknown` からは照合権を取り直す。
    if (SETTLED_STEP_STATES.includes(result.state) || result.state === 'unknown') {
      record.fence = null;
    }
    return { ok: true };
  }

  async acquireReconcile(
    operation: string,
    step: string,
    expectedGeneration: number,
  ): Promise<StepAcquisition> {
    const record = this.step(operation, step);
    if (!record) return { kind: 'not-acquired', state: 'conflict', generation: -1 };
    if (
      !UNRESOLVED_STEP_STATES.includes(record.state) ||
      record.generation !== expectedGeneration
    ) {
      return { kind: 'not-acquired', state: record.state, generation: record.generation };
    }
    return this.advance(operation, step, record, 'reconcile', record.state);
  }

  async release(
    operation: string,
    step: string,
    evidence: NotDispatchedEvidence,
    fence: string,
  ): Promise<FencedWrite | { ok: false; reason: 'missing-evidence' | 'not-reconciling' }> {
    const record = this.step(operation, step);
    if (!record) return { ok: false, reason: 'unknown-step' };
    if (record.fence?.token !== fence) return { ok: false, reason: 'stale-fence' };
    if (record.fence.mode !== 'reconcile') return { ok: false, reason: 'not-reconciling' };
    if (!isEvidence(evidence)) return { ok: false, reason: 'missing-evidence' };
    // 試行を追記したあとは送信したかもしれないため、「追記がない」ことを証拠にできない。
    if (evidence.kind === 'attempt-not-recorded' && record.attemptedSinceAcquire) {
      return { ok: false, reason: 'missing-evidence' };
    }
    record.state = 'prepared';
    record.generation += 1;
    record.fence = null;
    return { ok: true };
  }

  async listUnresolved(): Promise<UnresolvedStep[]> {
    const result: UnresolvedStep[] = [];
    for (const record of this.backing.operations.values()) {
      for (const [step, value] of record.steps) {
        if (UNRESOLVED_STEP_STATES.includes(value.state)) {
          result.push({
            operation: record.operation,
            step,
            state: value.state,
            generation: value.generation,
          });
        }
      }
    }
    return result;
  }

  private step(operation: string, step: string): MutableStep | undefined {
    return this.backing.operations.get(operation)?.steps.get(step);
  }

  private advance(
    operation: string,
    step: string,
    record: MutableStep,
    mode: 'send' | 'reconcile',
    state: StepRecord['state'],
  ): StepAcquisition {
    record.generation += 1;
    record.state = state;
    const token = `${operation}/${step}/${record.generation}/${mode}`;
    record.fence = { token, mode };
    return { kind: 'acquired', generation: record.generation, fence: token };
  }
}

function isEvidence(evidence: NotDispatchedEvidence | undefined | null): boolean {
  if (!evidence || typeof evidence !== 'object') return false;
  if (evidence.kind !== 'attempt-not-recorded' && evidence.kind !== 'provider-confirmed-absent') {
    return false;
  }
  return evidence.detail !== null && evidence.detail !== undefined && evidence.detail !== '';
}
