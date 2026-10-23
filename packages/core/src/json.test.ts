import { describe, expect, it } from 'vitest';
import { canonicalJson } from './json.js';
import { connectionIdentity, sameConnection, sameConnectionGeneration } from './connection.js';

describe('canonicalJson', () => {
  it('orders object keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"e":0,"f":1}]},"b":1}',
    );
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
  });
});

describe('connection identity', () => {
  const key = {
    principal: 'p',
    provider: 'google',
    tenant: 't',
    account: 'a',
    connection: 'c',
    generation: 1,
  };

  it('ignores the generation for identity but not for the current generation', () => {
    const next = { ...key, generation: 2 };
    expect(connectionIdentity(next)).toBe(connectionIdentity(key));
    expect(sameConnection(key, next)).toBe(true);
    expect(sameConnectionGeneration(key, next)).toBe(false);
  });

  it('treats another account as another connection', () => {
    expect(sameConnection(key, { ...key, account: 'b' })).toBe(false);
  });
});
