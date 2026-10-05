import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '.pnpm-store/**', 'fixtures/**', 'docs/spike/**'] },
  ...tseslint.configs.recommended,
);
