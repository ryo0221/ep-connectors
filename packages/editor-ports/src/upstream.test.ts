import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import upstream from '../upstream.json' with { type: 'json' };

describe('upstream.json', () => {
  it('records the commit each copy came from', () => {
    expect(upstream.repository).toBe('https://github.com/ryo0221/editor-platform');
    expect(upstream.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(upstream.copiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const copy of upstream.copies)
      for (const source of copy.sources) expect(source.lastChanged).toMatch(/^[0-9a-f]{40}$/);
  });

  it('lists exactly the exports of each copy', () => {
    for (const copy of upstream.copies) {
      const text = readFileSync(new URL(`../${copy.target}`, import.meta.url), 'utf8');
      const exported = [...text.matchAll(/^export (?:interface|type|const) (\w+)/gm)].map(
        (m) => m[1],
      );
      expect(exported).toEqual(copy.sources.flatMap((s) => s.symbols));
      expect(text).not.toMatch(/^import /m);
    }
  });
});
