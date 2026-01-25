/**
 * Project module - Configuration parsing and session resolution
 *
 * @module Project
 */

import YAML from 'yaml';

/**
 * Default project configuration values
 */
const DEFAULTS = {
  session: {
    python: {
      venv: '.venv',
      cwd: '.',
      name: 'default',
      auto_start: true,
    },
  },
  assets: {
    directory: '_assets',
  },
};

/**
 * Find the project root by walking up from startPath looking for mrmd.md
 *
 * @param {string} startPath - Path to start searching from
 * @param {(path: string) => boolean} hasFile - Function to check if mrmd.md exists at path
 * @returns {string | null} Project root path or null if not found
 *
 * @example
 * const root = Project.findRoot('/home/user/thesis/chapter/doc.md', (p) => fs.existsSync(p + '/mrmd.md'));
 * // Returns '/home/user/thesis' if mrmd.md exists there
 */
export function findRoot(startPath, hasFile) {
  if (!startPath) return null;

  // Normalize path (remove trailing slash)
  let current = startPath.replace(/\/+$/, '');

  // If startPath is a file, start from its directory
  // We detect this heuristically - if it has an extension, treat as file
  if (/\.[^/]+$/.test(current)) {
    const lastSlash = current.lastIndexOf('/');
    if (lastSlash > 0) {
      current = current.slice(0, lastSlash);
    }
  }

  // Walk up the directory tree
  while (current && current !== '/') {
    if (hasFile(current)) {
      return current;
    }

    // Go up one level
    const lastSlash = current.lastIndexOf('/');
    if (lastSlash <= 0) break;
    current = current.slice(0, lastSlash);
  }

  // Check root as well
  if (current === '/' && hasFile('/')) {
    return '/';
  }

  return null;
}

/**
 * Parse yaml config blocks from mrmd.md content
 *
 * Extracts all ```yaml config blocks and deep merges them in document order.
 *
 * @param {string} content - Content of mrmd.md file
 * @returns {object} Merged configuration object
 *
 * @example
 * const config = Project.parseConfig(`
 * # My Project
 * \`\`\`yaml config
 * name: "My Thesis"
 * session:
 *   python:
 *     venv: ".venv"
 * \`\`\`
 * `);
 * // Returns { name: 'My Thesis', session: { python: { venv: '.venv' } } }
 */
export function parseConfig(content) {
  if (!content) return {};

  // Match ```yaml config blocks (with optional whitespace)
  const regex = /```yaml\s+config\s*\n([\s\S]*?)```/g;
  let match;
  let config = {};

  while ((match = regex.exec(content)) !== null) {
    const yamlContent = match[1];
    try {
      const parsed = YAML.parse(yamlContent);
      if (parsed && typeof parsed === 'object') {
        config = deepMerge(config, parsed);
      }
    } catch (e) {
      // Invalid YAML, skip this block
      console.warn('Failed to parse yaml config block:', e.message);
    }
  }

  return config;
}

/**
 * Parse YAML frontmatter from document content
 *
 * @param {string} content - Document content
 * @returns {object | null} Parsed frontmatter or null if none
 *
 * @example
 * const fm = Project.parseFrontmatter(`---
 * title: "Chapter 1"
 * session:
 *   python:
 *     name: "gpu"
 * ---
 * # Content
 * `);
 * // Returns { title: 'Chapter 1', session: { python: { name: 'gpu' } } }
 */
export function parseFrontmatter(content) {
  if (!content) return null;

  // Frontmatter must start at the very beginning of the file
  if (!content.startsWith('---')) return null;

  // Find the closing ---
  const endMatch = content.slice(3).indexOf('\n---');
  if (endMatch === -1) return null;

  const yamlContent = content.slice(4, endMatch + 3);

  try {
    const parsed = YAML.parse(yamlContent);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
    return null;
  } catch (e) {
    // Invalid YAML
    return null;
  }
}

/**
 * Deep merge project config with document frontmatter
 *
 * Document frontmatter values override project config.
 *
 * @param {object} projectConfig - Project configuration
 * @param {object | null} frontmatter - Document frontmatter
 * @returns {object} Merged configuration
 */
export function mergeConfig(projectConfig, frontmatter) {
  if (!frontmatter) return projectConfig || {};
  if (!projectConfig) return frontmatter;

  return deepMerge(projectConfig, frontmatter);
}

/**
 * Resolve full session configuration for a document
 *
 * Computes absolute paths and full session name.
 *
 * @param {string} documentPath - Absolute path to document
 * @param {string} projectRoot - Absolute path to project root
 * @param {object} mergedConfig - Merged configuration
 * @returns {object} Resolved session config with absolute paths
 *
 * @example
 * const session = Project.resolveSession(
 *   '/home/user/thesis/chapter/doc.md',
 *   '/home/user/thesis',
 *   { name: 'thesis', session: { python: { venv: '.venv', cwd: '.', name: 'default' } } }
 * );
 * // Returns { name: 'thesis:default', venv: '/home/user/thesis/.venv', cwd: '/home/user/thesis', autoStart: true }
 */
export function resolveSession(documentPath, projectRoot, mergedConfig) {
  const pythonConfig = mergedConfig?.session?.python || {};
  const defaults = DEFAULTS.session.python;

  // Get values with defaults
  const venvRelative = pythonConfig.venv || defaults.venv;
  const cwdRelative = pythonConfig.cwd || defaults.cwd;
  const sessionName = pythonConfig.name || defaults.name;
  const autoStart = pythonConfig.auto_start !== undefined ? pythonConfig.auto_start : defaults.auto_start;
  const projectName = mergedConfig?.name || 'unnamed';

  // Resolve paths relative to project root
  const venv = resolvePath(projectRoot, venvRelative);
  const cwd = resolvePath(projectRoot, cwdRelative);

  return {
    name: `${projectName}:${sessionName}`,
    venv,
    cwd,
    autoStart,
  };
}

/**
 * Resolve a potentially relative path against a base directory
 * @private
 */
function resolvePath(basePath, relativePath) {
  if (!relativePath) return basePath;

  // If already absolute, return as-is
  if (relativePath.startsWith('/')) {
    return relativePath;
  }

  // Handle . as current directory
  if (relativePath === '.') {
    return basePath;
  }

  // Split paths into segments
  const baseSegments = basePath.split('/').filter(Boolean);
  const relativeSegments = relativePath.split('/').filter(Boolean);

  // Process relative path segments
  const resultSegments = [...baseSegments];

  for (const segment of relativeSegments) {
    if (segment === '..') {
      resultSegments.pop();
    } else if (segment !== '.') {
      resultSegments.push(segment);
    }
  }

  return '/' + resultSegments.join('/');
}

/**
 * Get default configuration values
 *
 * @returns {object} Default configuration
 */
export function getDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Deep merge two objects (source into target)
 * @private
 */
function deepMerge(target, source) {
  if (!source) return target;
  if (!target) return source;

  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];

    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      // Both are objects, recurse
      result[key] = deepMerge(targetVal, sourceVal);
    } else {
      // Source wins (including arrays)
      result[key] = sourceVal;
    }
  }

  return result;
}
