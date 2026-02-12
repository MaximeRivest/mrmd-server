/**
 * Runtime Resolver — unified resolution for native-language runtimes
 *
 * Supports three modes per language (checked in priority order):
 *
 * 1. REMOTE: env MRMD_{LANG}_URL → runtime already running elsewhere (feuille.dev)
 *    - No process spawned; just return the URL
 *    - Example: MRMD_R_URL=http://10.0.0.5:9001
 *
 * 2. EXPLICIT DIR: env MRMD_{LANG}_DIR → user points to a local checkout
 *    - Example: MRMD_R_DIR=/home/user/Projects/mrmd-r
 *
 * 3. SIBLING DEV: mrmd-electron's built-in sibling path (../../mrmd-{lang})
 *    - Works when running from the monorepo
 *
 * 4. VENDOR BUNDLE: shipped inside mrmd-server/vendor/mrmd-{lang}
 *    - Works when installed via npx / npm
 *
 * Each language needs:
 *   - envKey:       upper-case name for env vars (e.g., "R", "JULIA", "RUBY")
 *   - packageName:  directory name (e.g., "mrmd-r", "mrmd-julia")
 *   - markerFile:   file that proves the dir is valid (e.g., "DESCRIPTION", "Project.toml")
 *   - cliPath:      relative path inside the package to the CLI script
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Language definitions — add new languages here
 */
export const LANGUAGES = {
  r: {
    envKey: 'R',
    packageName: 'mrmd-r',
    markerFile: 'DESCRIPTION',
    cliPath: 'inst/bin/mrmd-r',
  },
  julia: {
    envKey: 'JULIA',
    packageName: 'mrmd-julia',
    markerFile: 'Project.toml',
    cliPath: 'bin/mrmd-julia',        // adjust when mrmd-julia exists
  },
  ruby: {
    envKey: 'RUBY',
    packageName: 'mrmd-ruby',
    markerFile: 'Gemfile',             // adjust when mrmd-ruby exists
    cliPath: 'bin/mrmd-ruby',
  },
};

/**
 * Resolve a runtime for the given language.
 *
 * @param {string} lang  — key in LANGUAGES (e.g. "r", "julia")
 * @returns {{ mode: 'remote', url: string }
 *          | { mode: 'local', packageDir: string, cliScript: string }
 *          | null }
 */
export function resolveRuntime(lang) {
  const def = LANGUAGES[lang];
  if (!def) return null;

  const envPrefix = `MRMD_${def.envKey}`;

  // ── 1. Remote URL ─────────────────────────────────────────────────────
  const remoteUrl = process.env[`${envPrefix}_URL`];
  if (remoteUrl) {
    console.log(`[runtime-resolver] ${lang}: using remote URL ${remoteUrl}`);
    return { mode: 'remote', url: remoteUrl };
  }

  // ── 2. Explicit directory ─────────────────────────────────────────────
  const explicitDir = process.env[`${envPrefix}_DIR`];
  if (explicitDir) {
    if (isValidPackageDir(explicitDir, def.markerFile)) {
      console.log(`[runtime-resolver] ${lang}: using explicit dir ${explicitDir}`);
      return {
        mode: 'local',
        packageDir: explicitDir,
        cliScript: path.join(explicitDir, def.cliPath),
      };
    }
    console.warn(`[runtime-resolver] ${lang}: ${envPrefix}_DIR=${explicitDir} is invalid (missing ${def.markerFile})`);
  }

  // ── 3. Sibling monorepo (mrmd-electron's __dirname/../../../mrmd-{lang}) ──
  //    We try multiple candidates because mrmd-electron can be at different depths
  const siblingCandidates = findSiblingCandidates(def.packageName);
  for (const candidate of siblingCandidates) {
    if (isValidPackageDir(candidate, def.markerFile)) {
      console.log(`[runtime-resolver] ${lang}: using sibling dev path ${candidate}`);
      return {
        mode: 'local',
        packageDir: candidate,
        cliScript: path.join(candidate, def.cliPath),
      };
    }
  }

  // ── 4. Vendor bundle (mrmd-server/vendor/mrmd-{lang}) ─────────────────
  const vendorDir = path.resolve(__dirname, '..', 'vendor', def.packageName);
  if (isValidPackageDir(vendorDir, def.markerFile)) {
    console.log(`[runtime-resolver] ${lang}: using vendor bundle ${vendorDir}`);
    return {
      mode: 'local',
      packageDir: vendorDir,
      cliScript: path.join(vendorDir, def.cliPath),
    };
  }

  console.warn(`[runtime-resolver] ${lang}: no runtime found`);
  return null;
}

/**
 * Check if a directory looks like a valid package for this language
 */
function isValidPackageDir(dir, markerFile) {
  try {
    return fs.existsSync(dir) && fs.existsSync(path.join(dir, markerFile));
  } catch {
    return false;
  }
}

/**
 * Generate sibling-path candidates.
 *
 * When mrmd-server is installed via npm, mrmd-electron is usually at:
 *   node_modules/mrmd-electron/src/services/
 * We want:
 *   node_modules/mrmd-{lang}/
 *
 * When running from a monorepo checkout:
 *   mrmd-packages/mrmd-server/  →  mrmd-packages/mrmd-{lang}/
 */
function findSiblingCandidates(packageName) {
  const candidates = [];

  // From mrmd-server's src/ dir → ../.. → mrmd-packages → mrmd-{lang}
  candidates.push(path.resolve(__dirname, '..', '..', packageName));

  // Also try relative to mrmd-electron if we can find it
  try {
    const electronPkg = import.meta.resolve
      ? new URL('mrmd-electron/package.json', import.meta.url)
      : null;

    if (electronPkg) {
      const electronDir = path.dirname(fileURLToPath(electronPkg));
      // mrmd-electron/../mrmd-{lang}
      candidates.push(path.resolve(electronDir, '..', packageName));
      // mrmd-electron/../../mrmd-{lang} (if in node_modules)
      candidates.push(path.resolve(electronDir, '..', '..', packageName));
    }
  } catch {
    // import.meta.resolve not available or failed
  }

  return [...new Set(candidates)]; // dedupe
}
