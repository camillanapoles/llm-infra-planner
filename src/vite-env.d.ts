/// <reference types="vite/client" />

/**
 * Build-time variables injected by Vite / CI (see `src/lib/env.ts`).
 * Every deploy target sets its own subset — all are optional with defaults.
 */
interface ImportMetaEnv {
  readonly BASE_URL: string;
  readonly MODE: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  /** local | dev | staging | production */
  readonly VITE_APP_ENV?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_COMMIT?: string;
  readonly VITE_BUILT_AT?: string;
  /** Optional absolute URL of a WASI runtime host; empty → same-origin /api */
  readonly VITE_WASI_BASE_URL?: string;
  readonly VITE_ANALYTICS_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
