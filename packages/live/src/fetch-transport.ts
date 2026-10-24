import type {
  HttpHeaders,
  HttpRequest,
  HttpTransport,
  OperationCatalog,
  SendResult,
} from '@ep-connectors/core';
import {
  checkCatalogRequest,
  normalizeHeaders,
  stripCredentialResponseHeaders,
} from '@ep-connectors/core';

// R2 の手動の実接続試験で使う、認証のない `HttpTransport` の `fetch` による実装。Host の境界の
// 規則（全体設計 3.2.1、3.7）を最小限に満たす。目録で検査した要求だけを送り、redirect を辿らず、
// 暗黙の retry をせず、応答の大きさと待ち時間に上限を置く。Token は扱わない。

export interface FetchHttpTransportOptions {
  /** 送ってよい操作の目録。Host の信頼できる設定から作る。 */
  catalog: OperationCatalog;
  /** 既定は `globalThis.fetch`。試験では差し替える。 */
  fetch?: typeof globalThis.fetch;
  /** 応答の全体を待つ上限。既定は 30 秒。 */
  timeoutMs?: number;
  /** 応答の body の上限（byte）。超えたら応答を捨てる。既定は 5 MiB。 */
  maxResponseBytes?: number;
  /** 配備の運用者が要求元を辿れるように付ける `user-agent`。 */
  userAgent?: string;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export class FetchHttpTransport implements HttpTransport {
  constructor(private readonly options: FetchHttpTransportOptions) {}

  async send(request: HttpRequest): Promise<SendResult> {
    const check = await checkCatalogRequest({
      catalog: this.options.catalog,
      request,
      auth: 'none',
    });
    if (!check.ok) return { ok: false, error: { kind: 'catalog', reason: check.reason } };

    const headers: HttpHeaders = normalizeHeaders(request.headers);
    if (this.options.userAgent !== undefined) headers['user-agent'] = this.options.userAgent;
    const fetch = this.options.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        // 3xx はそのまま応答として返す。移転先は目録の検査を通っていない。
        redirect: 'manual',
        credentials: 'omit',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch {
      // 送信の前に失敗したか区別できないため、送信後として扱う（読取は作用を残さない）。
      return { ok: false, error: { kind: 'transport', phase: 'after-send' } };
    }

    const body = await readLimited(
      response,
      this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    );
    if (body === null) return { ok: false, error: { kind: 'transport', phase: 'after-send' } };
    const received: HttpHeaders = {};
    response.headers.forEach((value, name) => {
      received[name.toLowerCase()] = value;
    });
    return {
      ok: true,
      response: {
        status: response.status,
        headers: stripCredentialResponseHeaders(received),
        body,
      },
    };
  }
}

/** 上限を超えた、または途中で切れた body は `null`。 */
async function readLimited(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
