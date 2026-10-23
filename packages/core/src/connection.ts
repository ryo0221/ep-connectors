/**
 * 一つの接続の識別（全体設計 3.1）。Handle は権限の証明ではないため、各差し口は
 * `HostPolicy.authorizeConnection` で現在の session のものかを確かめる。
 *
 * 再認証で別の account が選ばれたら新しい `connection` とし、旧 key を付け替えない。
 * 同じ account の再認証・scope の追加では `generation` を進める。
 */
export interface ConnectionKey {
  principal: string;
  provider: string;
  tenant: string;
  account: string;
  connection: string;
  generation: number;
}

/** 世代を含めない接続の同一性。`revoke` はこの単位で同期の基点を無効にする。 */
export function connectionIdentity(key: ConnectionKey): string {
  return JSON.stringify([key.principal, key.provider, key.tenant, key.account, key.connection]);
}

export function sameConnection(a: ConnectionKey, b: ConnectionKey): boolean {
  return connectionIdentity(a) === connectionIdentity(b);
}

export function sameConnectionGeneration(a: ConnectionKey, b: ConnectionKey): boolean {
  return sameConnection(a, b) && a.generation === b.generation;
}
