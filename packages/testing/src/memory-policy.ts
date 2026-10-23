import type { ConnectionKey, HostPolicy, JobRef, PolicyDecision } from '@ep-connectors/core';
import { sameConnectionGeneration } from '@ep-connectors/core';

/**
 * 試験で判定を切り替えられる `HostPolicy`。現在の session の接続を持ち、呼出しのたびに
 * その時点の設定から判定する。
 */
export class ControllablePolicy implements HostPolicy {
  readonly dispatchCalls: JobRef[] = [];
  private current: ConnectionKey[];
  private dispatchDecision: (job: JobRef) => PolicyDecision = () => ({ ok: true });

  constructor(connections: ConnectionKey[]) {
    this.current = [...connections];
  }

  setConnections(connections: ConnectionKey[]): void {
    this.current = [...connections];
  }

  decideDispatch(decide: (job: JobRef) => PolicyDecision): void {
    this.dispatchDecision = decide;
  }

  async authorizeConnection(key: ConnectionKey): Promise<PolicyDecision> {
    return this.current.some((candidate) => sameConnectionGeneration(candidate, key))
      ? { ok: true }
      : { ok: false, reason: 'not-current-session' };
  }

  async authorizeDispatch(job: JobRef): Promise<PolicyDecision> {
    this.dispatchCalls.push(structuredClone(job));
    return this.dispatchDecision(job);
  }
}
