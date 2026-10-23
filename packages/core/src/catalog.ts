import type { HttpMethod, HttpRequest } from './http.js';
import { CREDENTIAL_REQUEST_HEADERS, normalizeHeaders } from './http.js';
import type { JsonValue } from './json.js';

/**
 * Provider ごとに adapter が静的に宣言する操作の目録（全体設計 3.2.1）。Host はこの目録で
 * 要求を検査し、通ったものだけに token を付けて送る。目録は Host の信頼できる側に置き、
 * 実行時の申告で増やさない。
 */
export interface OperationCatalog {
  provider: string;
  operations: readonly CatalogOperation[];
}

export interface CatalogOperation {
  name: string;
  method: HttpMethod;
  /** scheme・host・port の完全一致で比べる origin（例 `https://www.googleapis.com`）。 */
  origin: string;
  /**
   * Path の型。`{name}` は一つの path segment に当たる。例 `/calendar/v3/calendars/{calendarId}/events`。
   */
  path: string;
  /** 許可する query parameter の名前。載っていない名前の要求は送らない。 */
  query?: readonly string[];
  /** 認証以外に許可する request header（小文字）。 */
  headers?: readonly string[];
  /** この操作に要る scope。connection の scope に一つでも欠ければ送らない。 */
  scopes: readonly string[];
  /**
   * `token` は `TokenStore.send` で認証を付けて送る。`none` は `HttpTransport` だけが送る
   * （公開タイル、署名付きのダウンロード URL など）。
   */
  auth: 'token' | 'none';
  /** GraphQL のように一つの endpoint で内容が変わる操作では、固定した document と変数の型を載せる。 */
  graphql?: GraphqlOperation;
}

export interface GraphqlOperation {
  /** `graphqlDocumentHash` で求めた、正規化した document の hash。 */
  documentHash: string;
  kind: 'query' | 'mutation';
  variables: Readonly<Record<string, GraphqlVariableRule>>;
}

export interface GraphqlVariableRule {
  type: 'string' | 'int' | 'boolean';
  required?: boolean;
  /** `int` の上限（件数の上限など）。 */
  max?: number;
  /** `string` の形（cursor など）。 */
  pattern?: string;
}

export type CatalogRejection =
  | 'unknown-operation'
  | 'auth-mismatch'
  | 'method'
  | 'origin'
  | 'path'
  | 'query'
  | 'url'
  | 'credential-header'
  | 'header'
  | 'scope'
  | 'graphql-document'
  | 'graphql-variables';

export type CatalogCheck =
  | { ok: true; operation: CatalogOperation }
  | { ok: false; reason: CatalogRejection; operation?: string };

export interface CatalogCheckInput {
  catalog: OperationCatalog;
  request: HttpRequest;
  /** 送る経路。`TokenStore.send` は `token`、`HttpTransport` は `none`。 */
  auth: 'token' | 'none';
  /** Connection が同意を得ている scope。`auth: 'none'` では見ない。 */
  grantedScopes?: readonly string[];
}

const SEGMENT = /^(?:[A-Za-z0-9\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})+$/;

/**
 * 要求を目録で検査する。Adapter の申告ではなく Host の側で呼ぶ。cursor・nextLink・redirect 先の
 * URL も、次の要求として同じ検査に通す。
 */
export async function checkCatalogRequest(input: CatalogCheckInput): Promise<CatalogCheck> {
  const { catalog, request, auth } = input;
  const operation = catalog.operations.find((candidate) => candidate.name === request.operation);
  const reject = (reason: CatalogRejection): CatalogCheck => ({
    ok: false,
    reason,
    operation: request.operation,
  });
  if (!operation) return reject('unknown-operation');
  if (operation.auth !== auth) return reject('auth-mismatch');
  if (operation.method !== request.method) return reject('method');

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return reject('url');
  }
  if (url.username || url.password || url.hash) return reject('url');
  if (url.protocol !== 'https:') return reject('origin');
  if (url.origin !== new URL(operation.origin).origin) return reject('origin');
  if (!matchesPath(operation.path, url.pathname)) return reject('path');
  const allowedQuery = operation.query ?? [];
  for (const name of url.searchParams.keys()) {
    if (!allowedQuery.includes(name)) return reject('query');
  }

  const headers = normalizeHeaders(request.headers);
  for (const name of Object.keys(headers)) {
    if (CREDENTIAL_REQUEST_HEADERS.includes(name)) return reject('credential-header');
    if (!(operation.headers ?? []).includes(name)) return reject('header');
  }

  if (auth === 'token') {
    const granted = input.grantedScopes ?? [];
    if (!operation.scopes.every((scope) => granted.includes(scope))) return reject('scope');
  }

  if (operation.graphql) {
    const graphql = await checkGraphql(operation.graphql, request.body);
    if (graphql) return reject(graphql);
  }
  return { ok: true, operation };
}

function matchesPath(pattern: string, pathname: string): boolean {
  const expected = pattern.split('/');
  const actual = pathname.split('/');
  if (expected.length !== actual.length) return false;
  return expected.every((part, index) => {
    const segment = actual[index] as string;
    if (part.startsWith('{') && part.endsWith('}')) {
      if (!SEGMENT.test(segment)) return false;
      const decoded = safeDecode(segment);
      return decoded !== null && decoded !== '.' && decoded !== '..' && !decoded.includes('/');
    }
    return part === segment;
  });
}

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

async function checkGraphql(
  rule: GraphqlOperation,
  body: string | undefined,
): Promise<CatalogRejection | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? '');
  } catch {
    return 'graphql-document';
  }
  if (!isRecord(parsed) || typeof parsed.query !== 'string') return 'graphql-document';
  for (const key of Object.keys(parsed)) {
    if (!['query', 'variables', 'operationName'].includes(key)) return 'graphql-document';
  }
  if ((await graphqlDocumentHash(parsed.query)) !== rule.documentHash) return 'graphql-document';

  const variables = parsed.variables ?? {};
  if (!isRecord(variables)) return 'graphql-variables';
  for (const [name, value] of Object.entries(variables)) {
    const variable = rule.variables[name];
    if (!variable || !matchesVariable(variable, value as JsonValue)) return 'graphql-variables';
  }
  for (const [name, variable] of Object.entries(rule.variables)) {
    if (variable.required && !(name in variables)) return 'graphql-variables';
  }
  return null;
}

function matchesVariable(rule: GraphqlVariableRule, value: JsonValue): boolean {
  if (value === null) return !rule.required;
  switch (rule.type) {
    case 'string':
      return typeof value === 'string' && (!rule.pattern || new RegExp(rule.pattern).test(value));
    case 'int':
      return Number.isInteger(value) && (rule.max === undefined || (value as number) <= rule.max);
    case 'boolean':
      return typeof value === 'boolean';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * GraphQL document を正規化した hash（`sha256:<hex>`）。comment を除き、空白をまとめ、
 * 記号の前後の空白を除く。Adapter は目録へ載せる hash をこの関数で求め、Host は送信の前に
 * 同じ関数で照合する。文字列リテラルを含まない固定の document を前提にする。
 */
export async function graphqlDocumentHash(document: string): Promise<string> {
  const normalized = document
    .replace(/#[^\n\r]*/g, ' ')
    .replace(/[\s,]+/g, ' ')
    .replace(/\s*([{}():!=[\]@$|&])\s*/g, '$1')
    .trim();
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(normalized),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'));
  return `sha256:${hex.join('')}`;
}
