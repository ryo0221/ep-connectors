// EditorPlatform の Host port から写した、公開してよい型。手で直さず
// `npm run editor-ports:sync -- <editor-platform の checkout>` で写し直す。
// 写した元の commit と symbol は upstream.json にある。

// packages/structured-data/src/host.ts

/** Host ports for reading external tables and work items into Structured Data
 * (docs/external-sources/editor-host-contract.md). Types and pure helpers only. The Host
 * resolves principals, permissions and providers; handles are not proof of permission, and
 * nothing read here enters native Data content unless a person imports it explicitly. */

export interface ExternalSourceNotice {
  kind: 'changed' | 'revoked';
  sourceHandle?: string;
}
/** One cell as the provider gave it. Dates stay provider values; the Editor types them. */
export type ExternalCellValue = string | number | boolean | null;
export interface TableSourceInfo {
  /** Opaque Host handle for one registered (spreadsheet, range) of the current principal. */
  handle: string;
  label: string;
  provider: string;
  account: string;
  /** The registered range as plain text, e.g. "Budget!A1:D20". */
  range: string;
}
export interface TableRead {
  sourceHandle: string;
  /** Connection generation; a read from an older generation is never shown. */
  generation: string;
  /** The range the provider resolved and returned. */
  resolvedRange: string;
  /** formatted: provider display strings, which depend on its locale. */
  valueRender: 'unformatted' | 'formatted';
  /** false when the Host cut rows at its limit. Rows past the cut are unknown, not empty. */
  complete: boolean;
  /** Row-major, each row padded to `columnCount` with null. */
  rows: ExternalCellValue[][];
  columnCount: number;
  fetchedAt: number;
}
export interface TableReadPort {
  listSources(signal: AbortSignal): Promise<TableSourceInfo[]>;
  readTable(request: { sourceHandle: string }, signal: AbortSignal): Promise<TableRead>;
  /** Change or revocation signals only; never content or commands. */
  watch?(notify: (notice: ExternalSourceNotice) => void): () => void;
}
