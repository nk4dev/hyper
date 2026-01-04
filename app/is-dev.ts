/**
 * Lightweight, synchronous helper to determine whether the app is running
 * in development mode.
 *
 * This is a replacement for the ESM-only `electron-is-dev` package so that
 * code compiled to CommonJS doesn't hit `ERR_REQUIRE_ESM` at runtime.
 *
 * Usage:
 * import isDev from './is-dev';
 *
 * The detection order:
 *  1. Explicit env vars: `ELECTRON_IS_DEV` or `ELECTRON_DEV` (accepts '1', 'true', 'yes', '0', 'false', 'no')
 *  2. `NODE_ENV === 'development'`
 *  3. `process.defaultApp` (true when running `electron .`)
 *  4. Heuristic checks on `process.execPath` (looks for `node_modules/.../electron` or an executable basename containing 'electron')
 */

import { basename, sep } from 'path';

function parseEnvBoolean(val?: string): boolean | undefined {
  if (val === undefined || val === null) {
    return undefined;
  }
  const v = val.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') {
    return true;
  }
  if (v === '0' || v === 'false' || v === 'no') {
    return false;
  }
  return undefined;
}

export const isDev: boolean = (() => {
  try {
    const env = process.env;

    // Explicit override via env
    const explicit = env.ELECTRON_IS_DEV ?? env.ELECTRON_DEV;
    const explicitBool = parseEnvBoolean(explicit);
    if (explicitBool !== undefined) {
      return explicitBool;
    }

    // NODE_ENV hint
    if (env.NODE_ENV === 'development') {
      return true;
    }

    // Running via `electron .` (unpacked / dev)
    if ((process as any).defaultApp) {
      return true;
    }

    // Exec path heuristics
    const execPath = process.execPath || '';
    if (execPath.includes(`node_modules${sep}electron`)) {
      return true;
    }
    if (basename(execPath).toLowerCase().includes('electron')) {
      return true;
    }
  } catch (err) {
    // If anything goes wrong, fall through to assuming production.
  }
  return false;
})();

export default isDev;
