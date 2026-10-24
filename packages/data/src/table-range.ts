/**
 * 表の一つのセルの値（Data 接続の設計 3）。Provider の書式・数式・型の推定は含めない。
 * 日付は Provider の値のまま（Google Sheets では serial number）で、型の解釈は Editor が行う。
 */
export type CellValue = string | number | boolean | null;

/** 値をどう取り出したか。`formatted` は Provider の表示形式（locale に依存する文字列）。 */
export type ValueRender = 'unformatted' | 'formatted';

/** 読んだ範囲の出典。Provider の値は未信頼の text として扱う。 */
export interface TableRangeSource {
  provider: string;
  /** Spreadsheet・workbook などの、範囲を含む資源の ID。 */
  container: string;
  /** 利用者が指定した範囲（A1 表記など）。 */
  requestedRange: string;
  /** Provider が解決して返した範囲。 */
  resolvedRange: string;
}

/**
 * 表の範囲の読取の DTO（Data 接続の設計 3）。公開済みの世代から組み立て、全体を取り終えた範囲だけを
 * 表す。途中まで取れた範囲を公開しないため、`complete` 以外の状態を持たない。
 */
export interface TableRangeRead {
  source: TableRangeSource;
  valueRender: ValueRender;
  /** 行優先。各行を `columnCount` の長さに揃え、空のセルは `null`。末尾の空の行・列は含まない。 */
  rows: CellValue[][];
  columnCount: number;
  /** `SyncStateStore` で公開された世代。 */
  generation: number;
  /** ISO 8601 の取得時刻（`Clock`）。過去の版ではなく、その時点の写しである。 */
  fetchedAt: string;
  /** `rows` と `resolvedRange` の hash（`sha256:<hex>`）。 */
  contentHash: string;
}
