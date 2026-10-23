import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/core/src/**/*.ts'],
    ignores: ['packages/core/src/**/*.test.ts'],
    rules: {
      // core は差し口の型と純粋な検査だけを持つ。通信・保管の実装を持ち込まない。
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*', 'fs', 'http', 'https', 'net'], message: 'core does not do I/O.' },
            { group: ['@ep-connectors/*'], message: 'core depends on no other package.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', 'fetch', 'setTimeout', 'setInterval'],
    },
  },
  {
    files: ['packages/github/src/**/*.ts'],
    ignores: ['packages/github/src/**/*.test.ts', 'packages/github/src/test/**'],
    rules: {
      // 分野のパッケージは core にだけ依存し、通信は TokenStore.send を通す。
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'http', 'https', 'net'],
              message: 'send through TokenStore.',
            },
            { group: ['@ep-connectors/testing'], message: 'testing is for tests only.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', 'fetch', 'setTimeout', 'setInterval'],
    },
  },
);
