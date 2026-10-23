import type { HttpHeaders, HttpMethod, HttpResponse } from '@ep-connectors/core';
import { normalizeHeaders } from '@ep-connectors/core';

/** 偽の Provider が受け取った要求。Token を含む header もそのまま残す（受信を数えるため）。 */
export interface ReceivedRequest {
  method: HttpMethod;
  url: string;
  headers: HttpHeaders;
  body?: string;
}

/** 実際に送る直前の要求。`TokenStore` / `HttpTransport` の実装が送信先として呼ぶ。 */
export type RawTransport = (request: ReceivedRequest) => Promise<HttpResponse>;

export type FakeRoute = (
  request: ReceivedRequest,
  params: Record<string, string>,
) => HttpResponse | Promise<HttpResponse>;

interface RouteEntry {
  method: HttpMethod;
  origin: string;
  path: string[];
  handler: FakeRoute;
}

/**
 * 決定的な偽の Provider。公式の仕様と Provider Notes で確認した振る舞いだけを route として与える。
 * Redirect を辿らず、受け取った要求をすべて記録する。
 */
export class FakeProvider {
  readonly received: ReceivedRequest[] = [];
  private readonly routes: RouteEntry[] = [];

  /** `url` は origin と path の型（`{name}` が一つの segment）。 */
  route(method: HttpMethod, url: string, handler: FakeRoute): this {
    const parsed = new URL(url.replace(/\{/g, '%7B').replace(/\}/g, '%7D'));
    this.routes.push({
      method,
      origin: parsed.origin,
      path: decodeURIComponent(parsed.pathname).split('/'),
      handler,
    });
    return this;
  }

  readonly transport: RawTransport = async (request) => {
    const recorded: ReceivedRequest = { ...request, headers: normalizeHeaders(request.headers) };
    this.received.push(recorded);
    const url = new URL(request.url);
    const actual = url.pathname.split('/');
    for (const route of this.routes) {
      if (route.method !== request.method || route.origin !== url.origin) continue;
      if (route.path.length !== actual.length) continue;
      const params: Record<string, string> = {};
      const matched = route.path.every((part, index) => {
        const segment = actual[index] as string;
        if (part.startsWith('{') && part.endsWith('}')) {
          params[part.slice(1, -1)] = decodeURIComponent(segment);
          return true;
        }
        return part === segment;
      });
      if (matched) return route.handler(recorded, params);
    }
    return {
      status: 404,
      headers: { 'content-type': 'application/json' },
      body: '{"error":"not found"}',
    };
  };

  receivedAt(origin: string): ReceivedRequest[] {
    return this.received.filter((request) => new URL(request.url).origin === origin);
  }
}

export function json(status: number, value: unknown, headers: HttpHeaders = {}): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(value),
  };
}
