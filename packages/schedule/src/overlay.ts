/**
 * Schedule の読取の DTO（R1）。EditorPlatform の `OverlayEvent` / `OverlayRead`
 * （`packages/schedule/src/host.ts`）と同じ形にし、Host が source handle を付けて
 * `ScheduleReadPort.readRange` の戻り値へ組み立てる。公開の port 契約として固定するのは C0 の残りで行う。
 */

/** 一つの外部予定。本人向けの DTO にだけ入れ、Schedule の content へ保存しない。 */
export interface OverlayEvent {
  id: string;
  sourceHandle: string;
  /** Epoch ms。終日の予定では UTC の 0 時（EditorPlatform の mock Host と同じ）。 */
  start: number;
  end: number;
  /** 終日の予定の日付。end は含まない。Timezone を通さずに日付として置く。 */
  allDay?: { startDate: string; endDate: string };
  /** 未信頼の Provider の文字列を plain text にしたもの。 */
  title?: string;
  notes?: string;
}

export interface OverlayRange {
  from: number;
  to: number;
}

export interface OverlayRead {
  sourceHandle: string;
  /** 接続の世代。古い世代の読取は表示しない。 */
  generation: string;
  range: OverlayRange;
  /** ページの失敗、上限、権限を確かめられなかったとき、baseline がないときは false。 */
  complete: boolean;
  /** 読めていない範囲。空きではなく不明である。 */
  missing: OverlayRange[];
  /** 公開済みの同期を取った時刻（epoch ms）。一度も取れていなければ null。 */
  fetchedAt: number | null;
  events: OverlayEvent[];
}

/** 未信頼の Provider の文字列を、制御文字を除いた長さに上限のある plain text にする。 */
export function plainExternalText(value: unknown, max = 2000): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  const characters = [...text];
  return characters.length > max ? characters.slice(0, max).join('') + '…' : text;
}

/** `range` のうち `covered` に含まれない部分。 */
export function uncovered(range: OverlayRange, covered: OverlayRange): OverlayRange[] {
  if (covered.to <= range.from || covered.from >= range.to) return [range];
  const result: OverlayRange[] = [];
  if (range.from < covered.from) result.push({ from: range.from, to: covered.from });
  if (covered.to < range.to) result.push({ from: covered.to, to: range.to });
  return result;
}
