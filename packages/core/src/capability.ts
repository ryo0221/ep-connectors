/** 条件付き書込の保証（EditorPlatform の Editor–Host 契約 2.1）。 */
export type ConditionalWrite = 'serverPrecondition' | 'bestEffort' | 'unsupported' | 'unverified';

export type CapabilityStatus =
  | { available: true }
  /** 実接続の試験で確かめるまで、Provider の保証に依存する操作はこれにする。 */
  | {
      available: false;
      reason: 'unverified' | 'unsupported-by-provider' | 'host-port-missing' | 'not-granted';
    };

/**
 * 操作ごとの能力の宣言（全体設計 4）。Provider 名だけで決めず、Host の差し口の性質
 * （台帳の耐久性、Webhook の受信可否）も反映する。
 */
export interface OperationCapability {
  operation: string;
  status: CapabilityStatus;
  conditionalWrite?: ConditionalWrite;
  /** 作成時の重複抑止。保証の範囲と照合の手段を書く。 */
  deduplication?: { mechanism: string; verified: boolean };
}

/** Host の差し口の性質。能力の組み立てに使う。 */
export interface HostPortTraits {
  durableLedger: boolean;
  webhookIntake: boolean;
  backgroundQueue: boolean;
}
