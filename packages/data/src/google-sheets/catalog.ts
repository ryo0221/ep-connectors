import type { OperationCatalog } from '@ep-connectors/core';

export const GOOGLE_SHEETS_PROVIDER = 'google-sheets';
export const SHEETS_ORIGIN = 'https://sheets.googleapis.com';
export const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

/**
 * Google Sheets の操作の目録（全体設計 3.2.1）。R1 は値の範囲の読取だけを載せる。
 *
 * 範囲は sheet 名を含み `/` も書けるため、path ではなく `values:batchGet` の query（`ranges`）で渡す。
 * 一回の要求で読む範囲は一つに限るが、query の値の数は目録では縛れないため adapter が守る。
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
    },
  ],
};
