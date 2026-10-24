import { defineConfig } from 'vitest/config';

// 実サービスへの読取だけの手動の試験（R2）。通常の `npm test`・CI では動かさない。
export default defineConfig({
  test: {
    include: ['packages/**/*.live.test.ts'],
    testTimeout: 120_000,
    // 配備に負荷をかけないよう、ファイルも試験も一つずつ動かす。
    fileParallelism: false,
  },
});
