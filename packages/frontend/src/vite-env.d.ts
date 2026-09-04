/// <reference types="vite/client" />

/**
 * Typed build-time environment.
 *
 * `tsconfig.json` pins `types` to the test globals, which suppresses Vite's
 * automatic ambient types — so the triple-slash reference above is what makes
 * `import.meta.env` and side-effect CSS imports resolve.
 *
 * VITE_API_BASE_URL is the deployed backend origin, inlined at build time by
 * Vite. It is PUBLIC: anything in import.meta.env ships in the bundle, so an
 * API token must never be added here. The operator token is entered at
 * runtime and held in sessionStorage (see components/AuthGate.tsx).
 */
interface ImportMetaEnv {
  /** Backend origin, e.g. https://recoverai-backend-ue80.onrender.com. Empty in dev, where Vite proxies /api. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
