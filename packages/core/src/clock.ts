/** 期限・待機・重複抑止 key を試験で決定的にするため、外から渡す（全体設計 3.7）。 */
export interface Clock {
  /** ISO 8601 の現在時刻。 */
  now(): string;
}

export interface IdSource {
  next(prefix: string): string;
}
