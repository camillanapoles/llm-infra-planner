/**
 * Build/runtime environment descriptor.
 *
 * The same codebase is published to four targets (see `.kiro/specs/`):
 *   local       → `npm run dev` / Arena preview / any laptop
 *   dev         → GitHub Pages /dev/ subpath (auto-deploy on branch `dev`)
 *   staging     → GitHub Pages /staging/ subpath (branch `staging`)
 *   production  → GitHub Pages root (branch `main`) or Docker/nginx
 *
 * Values are injected at build time by Vite (`VITE_*`) and by the CI workflows.
 */

export type AppEnv = 'local' | 'dev' | 'staging' | 'production';

const rawEnv = (import.meta.env?.VITE_APP_ENV as string | undefined)?.toLowerCase();

function resolveEnv(): AppEnv {
  if (rawEnv === 'dev' || rawEnv === 'staging' || rawEnv === 'production') return rawEnv;
  return 'local';
}

export const APP_ENV: AppEnv = resolveEnv();

/** Base path the bundle was built with (`/`, `/llm-infra-planner/`, `/dev/`, ...). */
export const BASE_PATH: string = import.meta.env?.BASE_URL ?? '/';

export const APP_VERSION: string = (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? '0.0.0';

/** Commit SHA injected by CI (short form). */
export const COMMIT_SHA: string = (import.meta.env?.VITE_COMMIT as string | undefined) ?? 'local';

/** ISO timestamp of the build. */
export const BUILT_AT: string = (import.meta.env?.VITE_BUILT_AT as string | undefined) ?? new Date().toISOString();

/** Where the WASI runtime host lives. Empty → same origin (`/api/*`, proxied). */
export const WASI_BASE_URL: string = (import.meta.env?.VITE_WASI_BASE_URL as string | undefined) ?? '';

export interface EnvDescriptor {
  env: AppEnv;
  label: string;
  /** true when the build is meant to be shared with users (not a laptop). */
  isDeployed: boolean;
  /** true when a server side exists to proxy `/api/*` to the WASI module. */
  hasBackend: boolean;
  accent: string;
}

export const ENV_DESCRIPTORS: Record<AppEnv, EnvDescriptor> = {
  local: { env: 'local', label: 'Local', isDeployed: false, hasBackend: true, accent: 'text-fg-muted' },
  dev: { env: 'dev', label: 'Dev', isDeployed: true, hasBackend: false, accent: 'text-amber-500' },
  staging: { env: 'staging', label: 'Staging', isDeployed: true, hasBackend: false, accent: 'text-sky-500' },
  production: { env: 'production', label: 'Production', isDeployed: true, hasBackend: true, accent: 'text-emerald-500' },
};

export const ENV: EnvDescriptor = ENV_DESCRIPTORS[APP_ENV];

/** Public URL of each deployed environment (GitHub Pages project site). */
export const ENV_URLS: Record<AppEnv, string> = {
  local: 'http://localhost:5173/',
  dev: 'https://camillanapoles.github.io/llm-infra-planner/dev/',
  staging: 'https://camillanapoles.github.io/llm-infra-planner/staging/',
  production: 'https://camillanapoles.github.io/llm-infra-planner/',
};

export const BUILD_INFO = {
  env: APP_ENV,
  version: APP_VERSION,
  commit: COMMIT_SHA,
  builtAt: BUILT_AT,
  base: BASE_PATH,
} as const;
