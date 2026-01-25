/**
 * mrmd-project
 *
 * Pure logic for understanding mrmd project structure and conventions.
 *
 * This package has NO side effects - no file I/O, no process spawning.
 * All functions are pure: same input → same output.
 *
 * @example
 * import { Project, FSML, Links, Assets, Scaffold, Search } from 'mrmd-project';
 *
 * // Find and parse project
 * const root = Project.findRoot('/path/to/file.md', hasFile);
 * const config = Project.parseConfig(mrmdMdContent);
 *
 * // Build navigation tree
 * const tree = FSML.buildNavTree(files);
 *
 * // Resolve internal links
 * const resolved = Links.resolve('installation', 'index.md', projectFiles);
 *
 * // Compute asset paths
 * const relativePath = Assets.computeRelativePath('chapter/doc.md', '_assets/img.png');
 *
 * // Generate scaffolding
 * const scaffold = Scaffold.project('my-project');
 *
 * // Fuzzy search
 * const results = Search.files('thesis readme', allFiles);
 */

// Project configuration
export * as Project from './project.js';

// Filesystem Markup Language
export * as FSML from './fsml.js';

// Internal links
export * as Links from './links.js';

// Asset management
export * as Assets from './assets.js';

// Scaffolding templates
export * as Scaffold from './scaffold.js';

// Search utilities
export * as Search from './search.js';

// Re-export everything as default for convenience
import * as Project from './project.js';
import * as FSML from './fsml.js';
import * as Links from './links.js';
import * as Assets from './assets.js';
import * as Scaffold from './scaffold.js';
import * as Search from './search.js';

export default {
  Project,
  FSML,
  Links,
  Assets,
  Scaffold,
  Search,
};
