import type { HostPortTraits, OperationCapability } from '@ep-connectors/core';

/**
 * 能力の宣言（全体設計 4）。読取だけを持つ。OGC API Features には変更通知がないため、写しの
 * 定期的な更新は Host のキューに依存する。書込み（Part 4）は R1 の範囲外であり、宣言しない。
 */
export function ogcFeaturesCapabilities(traits: HostPortTraits): OperationCapability[] {
  return [
    { operation: 'features.describeCollection', status: { available: true } },
    { operation: 'features.readPage', status: { available: true } },
    { operation: 'features.sync', status: { available: true } },
    {
      operation: 'features.scheduledRefresh',
      status: traits.backgroundQueue
        ? { available: true }
        : { available: false, reason: 'host-port-missing' },
    },
    {
      operation: 'features.changeNotification',
      status: { available: false, reason: 'unsupported-by-provider' },
    },
  ];
}
