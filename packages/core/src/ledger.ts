import type { JsonValue } from './json.js';

/** EditorPlatform の Editor–Host 契約 5 の step 状態。 */
export type StepState =
  | 'prepared'
  | 'dispatching'
  | 'accepted'
  | 'failed-after-acceptance'
  | 'unknown'
  | 'verified'
  | 'rejected'
  | 'conflict'
  | 'cancelled-before-dispatch';

/** 記録したあとに送信権・照合権を持ち越さない状態。 */
export const SETTLED_STEP_STATES: readonly StepState[] = [
  'verified',
  'rejected',
  'failed-after-acceptance',
  'conflict',
  'cancelled-before-dispatch',
];

/** 再起動後に照合が要る状態（`listUnresolved` が返す）。 */
export const UNRESOLVED_STEP_STATES: readonly StepState[] = ['dispatching', 'accepted', 'unknown'];

export interface ClaimInput {
  /** 公開枠。初期版では作成元の Artifact ID / event ID と、正規化した Provider 上の登録先。 */
  slot: string;
  operation: string;
  planDigest: string;
  /** 凍結した計画。Job を実行するときに、ここから送る内容を読み直す。 */
  plan: JsonValue;
  steps: readonly string[];
}

export type ClaimResult =
  | { kind: 'claimed' }
  /** 同じ枠をすでに持つ operation（同じ operation の再 claim を含む）。Step の送信権の証明ではない。 */
  | { kind: 'existing'; operation: string }
  /** 同じ operation ID で違う計画。 */
  | { kind: 'conflict' };

export interface StepRecord {
  state: StepState;
  /** 送信権・照合権を得るたびに進む世代。 */
  generation: number;
  attempts: readonly AttemptRecord[];
  result?: StepResultRecord;
}

export interface OperationRecord {
  operation: string;
  slot: string;
  planDigest: string;
  plan: JsonValue;
  steps: Readonly<Record<string, StepRecord>>;
}

export interface AttemptRecord {
  step: string;
  attempt: number;
  /** Provider 固有の重複抑止 key（Google の event ID、Graph の transactionId など）。 */
  idempotencyKey?: string;
  at: string;
}

/** 送信の結果。Raw response ではなく、照合に要る field だけを残す（全体設計 5）。 */
export interface StepResultRecord {
  state: Exclude<StepState, 'prepared' | 'dispatching' | 'cancelled-before-dispatch'>;
  /** 外部 ID の Host 内参照。 */
  externalRef?: string;
  providerRequestId?: string;
  readback?: JsonValue;
  at: string;
}

export type StepAcquisition =
  | { kind: 'acquired'; generation: number; fence: string }
  | { kind: 'not-acquired'; state: StepState; generation: number };

export type FencedWrite = { ok: true } | { ok: false; reason: 'stale-fence' | 'unknown-step' };

/** 未送信の証拠。Provider で該当の資源がないことだけでは証拠にしない（schedule 4.1）。 */
export interface NotDispatchedEvidence {
  kind: 'attempt-not-recorded' | 'provider-confirmed-absent';
  detail: JsonValue;
}

export interface UnresolvedStep {
  operation: string;
  step: string;
  state: StepState;
  generation: number;
}

/**
 * 外部に結果が残る操作の記録（全体設計 3.3）。`claim` は同じ予定の多重公開を、`acquireStep` は
 * 同じ step の多重送信を防ぐ。二つは別の保証である。各操作は Host の保管で atomic に行う。
 */
export interface OperationLedger {
  claim(input: ClaimInput): Promise<ClaimResult>;
  read(operation: string): Promise<OperationRecord | null>;
  /** `prepared` で世代が一致するときだけ `dispatching` へ遷移させ、新しい fencing token を返す。 */
  acquireStep(
    operation: string,
    step: string,
    expectedGeneration: number,
  ): Promise<StepAcquisition>;
  /** 送信の直前に試行を追記する。現在の fencing token でなければ拒否する。 */
  appendAttempt(operation: string, attempt: AttemptRecord, fence: string): Promise<FencedWrite>;
  recordResult(
    operation: string,
    step: string,
    result: StepResultRecord,
    fence: string,
  ): Promise<FencedWrite>;
  /** `dispatching` / `accepted` / `unknown` の step の照合権を得る。世代を進め、それまでの token を無効にする。 */
  acquireReconcile(
    operation: string,
    step: string,
    expectedGeneration: number,
  ): Promise<StepAcquisition>;
  /** 照合権を持つ worker が、未送信を証明できた step だけを `prepared` へ戻す。 */
  release(
    operation: string,
    step: string,
    evidence: NotDispatchedEvidence,
    fence: string,
  ): Promise<FencedWrite | { ok: false; reason: 'missing-evidence' | 'not-reconciling' }>;
  listUnresolved(): Promise<UnresolvedStep[]>;
}
