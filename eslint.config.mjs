import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist/**', '**/node_modules/**', 'test/fixtures/**']),
  {
    files: ['**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['packages/*/src/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    files: ['packages/cutegantt/src/model.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-declaration-merging': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    files: ['test/browser.test.mjs'],
    languageOptions: { globals: globals.browser },
  },
  prettier,
);
