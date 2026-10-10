// ESLint flat config. The tree is first-party strict TypeScript; vendored
// content, build output, and golden fixtures are ignored wholesale.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'vendor/**',
      'dist/**',
      'dist-snapshot/**',
      '.tmp-init*/**',
      '.tmp-*/**',
      'graphify-out/**',
      '.graphify_detect.json',
      '.omc/**',
      'test/fixtures/init-standalone/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      sonarjs,
    },
    rules: {
      // Project decision (recorded in the TypeScript-wave ADR): maximum cycle
      // complexity of 10 keeps CLI modules reviewable after the rename wave.
      complexity: ['error', 10],
      // sonarjs default threshold; kept explicit because the plugin is loaded
      // specifically for this rule.
      'sonarjs/cognitive-complexity': ['error', 15],
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // Plain-JS files that never join a tsconfig project (the config file
    // itself, and transitional .js during the rename wave) must not hit
    // type-aware rules.
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);