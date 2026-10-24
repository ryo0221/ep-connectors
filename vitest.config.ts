import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `*.live.test.ts` は実サービスへ送る手動の試験。`npm run test:live` でだけ動かす。
  test: {
    include: ['packages/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.live.test.ts'],
  },
});
