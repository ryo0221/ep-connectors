import type { OperationCatalog } from '@ep-connectors/core';

export const GOOGLE_SHEETS_PROVIDER = 'google-sheets';
export const SHEETS_ORIGIN = 'https://sheets.googleapis.com';
export const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
/** `HostPolicy.authorizeResources` に渡す資源の種類。ID は spreadsheet ID。 */
export const SPREADSHEET_RESOURCE = 'google-sheets.spreadsheet';
/**
 * 範囲の資源。ID は A1 表記の範囲そのもので、同じ呼出しの `SPREADSHEET_RESOURCE` の中の範囲を指す。
 * Host は登録した（spreadsheet、範囲）の組と完全一致で比べ、範囲の包含を推定しない。
 */
export const RANGE_RESOURCE = 'google-sheets.range';

/**
 * Google Sheets の操作の目録（全体設計 3.2.1）。R1 は値の範囲の読取だけを載せる。
 *
 * 範囲は sheet 名を含み `/` も書けるため、path ではなく `values:batchGet` の query（`ranges`）で渡す。
 * 要求ごとに spreadsheet と範囲を資源として取り出し、Host が principal・project ごとに認可してから送る
 * （全体設計 3.2.1）。範囲の資源はちょうど一つの `ranges` からだけ取り出すため、範囲を二つ以上
 * 含む要求も、範囲のない要求も送られない。OAuth の scope は、接続がその spreadsheet を読めることの
 * 証明であって、project が読んでよいことの証明ではない。
 */
export const GOOGLE_SHEETS_CATALOG: OperationCatalog = {
  provider: GOOGLE_SHEETS_PROVIDER,
  operations: [
    {
      name: 'sheets.values.batchGet',
      method: 'GET',
      origin: SHEETS_ORIGIN,
      path: '/v4/spreadsheets/{spreadsheetId}/values:batchGet',
      query: ['ranges', 'majorDimension', 'valueRenderOption', 'dateTimeRenderOption'],
      scopes: [SHEETS_READONLY_SCOPE],
      auth: 'token',
      resources: [
        { kind: SPREADSHEET_RESOURCE, path: ['spreadsheetId'] },
        { kind: RANGE_RESOURCE, query: 'ranges' },
      ],
    },
  ],
};
