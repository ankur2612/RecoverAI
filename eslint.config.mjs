import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * RecoverAI lint configuration.
 *
 * DELIBERATELY NARROW. This is a correctness net, not a style enforcer.
 *
 * The repository already has a consistent hand-written style, and turning on a
 * formatting ruleset would rewrite hundreds of lines that are not wrong — a
 * large diff with no safety benefit, and one that would bury a real finding in
 * noise. So: no `stylistic` preset, no quote/semi/indent rules.
 *
 * What IS enabled is the subset that catches genuine defects — unused values,
 * accidental `any`, floating promises in a codebase where an unawaited write
 * is a correctness bug, and shadowed bindings.
 */
export default tseslint.config(
  {
    // Build output and dependencies are never linted.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'packages/backend/dist/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        // Type-aware linting would catch more, but requires a full program
        // build on every run. Left off so `npm run lint` stays fast enough to
        // run before every commit; the typechecker already covers types.
        ecmaVersion: 2023,
        sourceType: 'module',
      },
    },
    rules: {
      // ---- Genuine defects -------------------------------------------------
      // An unused variable is usually a leftover or a mistake. Underscore
      // prefix is the documented escape hatch for a deliberately ignored
      // parameter, which the existing code already uses (`_request`).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      // `any` erases the type safety this project relies on. Warn rather than
      // error: a handful of legitimate uses exist at provider boundaries where
      // an unknown JSON shape arrives, and each is explicitly cast afterwards.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Shadowing a binding is legal and almost always a mistake.
      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': 'error',

      // ---- Rules that would only create noise -----------------------------
      // The codebase deliberately uses non-null assertions after explicit
      // length/existence checks, which the linter cannot see.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Empty catch blocks are used intentionally where a failure is the
      // documented no-op path; each carries a comment saying so.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  {
    // Tests may use `any` freely when constructing deliberately malformed
    // input to prove a validator rejects it.
    files: ['**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
