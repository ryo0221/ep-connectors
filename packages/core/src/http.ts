export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** header 名は小文字に揃える。 */
export type HttpHeaders = Record<string, string>;

/**
 * Adapter が組み立てる serialize できる HTTP 要求（全体設計 3.2）。`operation` は
 * Provider の操作の目録の操作名で、Host はこれを目録と照合してから送る。
 */
export interface HttpRequest {
  operation: string;
  method: HttpMethod;
  url: string;
  headers?: HttpHeaders;
  /** text の body。binary は扱う分野が必要になったときに足す。 */
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: HttpHeaders;
  body: string;
}

/** Adapter に指定させない、認証に関わる header（全体設計 3.2.1）。 */
export const CREDENTIAL_REQUEST_HEADERS: readonly string[] = [
  'authorization',
  'cookie',
  'proxy-authorization',
];

/** 応答から除いて adapter へ返す header。 */
export const CREDENTIAL_RESPONSE_HEADERS: readonly string[] = [
  'set-cookie',
  'set-cookie2',
  'www-authenticate',
  'proxy-authenticate',
  'authentication-info',
  'proxy-authentication-info',
];

export function normalizeHeaders(headers: HttpHeaders | undefined): HttpHeaders {
  const result: HttpHeaders = {};
  for (const [name, value] of Object.entries(headers ?? {})) result[name.toLowerCase()] = value;
  return result;
}

/** 認証に関わる header を除いた応答の header。 */
export function stripCredentialResponseHeaders(headers: HttpHeaders): HttpHeaders {
  const result: HttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!CREDENTIAL_RESPONSE_HEADERS.includes(lower)) result[lower] = value;
  }
  return result;
}

export function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}
