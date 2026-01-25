# mrmd-project Specification

> Pure logic for understanding mrmd project structure and conventions.

**Mission:** Given file paths and contents, compute everything needed to understand project structure, resolve sessions, handle links, and manage assets.

**Properties:**
- Zero I/O, zero side effects
- Works in Node, browser, anywhere
- All functions are pure: same input → same output

---

## Installation & Usage

```javascript
import { Project, FSML, Links, Assets, Scaffold, Search } from 'mrmd-project';
```

---

## 1. Project Module

### 1.1 Project.findRoot

Walk up from a path to find the project root (directory containing `mrmd.md`).

```typescript
function findRoot(startPath: string, hasFile: (path: string) => boolean): string | null
```

**Note:** `hasFile` is injected to avoid I/O in the pure function.

```javascript
// Test: findRoot with mrmd.md present
const hasFile = (p) => [
  '/home/user/thesis/mrmd.md',
  '/home/user/thesis/chapter1.md',
  '/home/user/thesis/02-methods/intro.md',
].some(f => f === p || f.startsWith(p + '/'));

const root = Project.findRoot('/home/user/thesis/02-methods/intro.md',
  (p) => hasFile(p + '/mrmd.md'));

console.assert(root === '/home/user/thesis', `Expected /home/user/thesis, got ${root}`);
console.log('✓ findRoot finds mrmd.md in ancestor');
```

```javascript
// Test: findRoot with no project
const root = Project.findRoot('/home/user/random/file.md', () => false);

console.assert(root === null, `Expected null, got ${root}`);
console.log('✓ findRoot returns null when no project');
```

---

### 1.2 Project.parseConfig

Extract and merge `yaml config` blocks from mrmd.md content.

```typescript
interface ProjectConfig {
  name?: string;
  description?: string;
  session?: {
    python?: {
      venv?: string;
      cwd?: string;
      name?: string;
      auto_start?: boolean;
    };
  };
  nav?: {
    order?: string[];
  };
  assets?: {
    directory?: string;
  };
  build?: {
    output?: string;
    formats?: string[];
  };
}

function parseConfig(mrmdMdContent: string): ProjectConfig
```

```javascript
// Test: parseConfig with single block
const content = `# My Project

Some description.

\`\`\`yaml config
name: "My Thesis"
session:
  python:
    venv: ".venv"
\`\`\`
`;

const config = Project.parseConfig(content);

console.assert(config.name === 'My Thesis', `Expected "My Thesis", got ${config.name}`);
console.assert(config.session.python.venv === '.venv', `Expected ".venv", got ${config.session?.python?.venv}`);
console.log('✓ parseConfig extracts single yaml config block');
```

```javascript
// Test: parseConfig with multiple blocks (deep merge)
const content = `# My Project

\`\`\`yaml config
name: "My Thesis"
session:
  python:
    venv: ".venv"
\`\`\`

More prose here.

\`\`\`yaml config
session:
  python:
    name: "default"
    cwd: "."
\`\`\`
`;

const config = Project.parseConfig(content);

console.assert(config.name === 'My Thesis');
console.assert(config.session.python.venv === '.venv');
console.assert(config.session.python.name === 'default');
console.assert(config.session.python.cwd === '.');
console.log('✓ parseConfig deep merges multiple yaml config blocks');
```

```javascript
// Test: parseConfig ignores non-config yaml blocks
const content = `# Example

\`\`\`yaml
not: "config"
\`\`\`

\`\`\`yaml config
name: "Real Config"
\`\`\`
`;

const config = Project.parseConfig(content);

console.assert(config.name === 'Real Config');
console.assert(config.not === undefined);
console.log('✓ parseConfig ignores yaml blocks without config tag');
```

---

### 1.3 Project.parseFrontmatter

Extract YAML frontmatter from document content.

```typescript
interface DocumentFrontmatter {
  title?: string;
  session?: {
    python?: {
      name?: string;
      venv?: string;
      cwd?: string;
    };
  };
  [key: string]: any;
}

function parseFrontmatter(documentContent: string): DocumentFrontmatter | null
```

```javascript
// Test: parseFrontmatter extracts frontmatter
const content = `---
title: "GPU Experiments"
session:
  python:
    name: "gpu-session"
---

# GPU Experiments

Content here...
`;

const fm = Project.parseFrontmatter(content);

console.assert(fm.title === 'GPU Experiments');
console.assert(fm.session.python.name === 'gpu-session');
console.log('✓ parseFrontmatter extracts YAML frontmatter');
```

```javascript
// Test: parseFrontmatter returns null when no frontmatter
const content = `# No Frontmatter

Just content.
`;

const fm = Project.parseFrontmatter(content);

console.assert(fm === null);
console.log('✓ parseFrontmatter returns null when no frontmatter');
```

---

### 1.4 Project.mergeConfig

Merge project config with document frontmatter (document wins).

```typescript
function mergeConfig(
  projectConfig: ProjectConfig,
  frontmatter: DocumentFrontmatter | null
): MergedConfig
```

```javascript
// Test: mergeConfig with document override
const projectConfig = {
  name: 'My Thesis',
  session: { python: { venv: '.venv', name: 'default', cwd: '.' } }
};

const frontmatter = {
  title: 'GPU Chapter',
  session: { python: { name: 'gpu-session' } }
};

const merged = Project.mergeConfig(projectConfig, frontmatter);

console.assert(merged.session.python.venv === '.venv', 'venv from project');
console.assert(merged.session.python.name === 'gpu-session', 'name overridden by doc');
console.assert(merged.session.python.cwd === '.', 'cwd from project');
console.log('✓ mergeConfig: document overrides project, rest preserved');
```

---

### 1.5 Project.resolveSession

Determine the full session configuration for a document.

```typescript
interface ResolvedSession {
  name: string;           // e.g., "my-thesis:default"
  venv: string;           // Absolute path to venv
  cwd: string;            // Absolute working directory
  autoStart: boolean;
}

function resolveSession(
  documentPath: string,
  projectRoot: string,
  mergedConfig: MergedConfig
): ResolvedSession
```

```javascript
// Test: resolveSession computes full session config
const session = Project.resolveSession(
  '/home/user/thesis/02-methods/intro.md',
  '/home/user/thesis',
  {
    name: 'my-thesis',
    session: { python: { venv: '.venv', cwd: '.', name: 'default', auto_start: true } }
  }
);

console.assert(session.name === 'my-thesis:default');
console.assert(session.venv === '/home/user/thesis/.venv');
console.assert(session.cwd === '/home/user/thesis');
console.assert(session.autoStart === true);
console.log('✓ resolveSession computes absolute paths and full session name');
```

```javascript
// Test: resolveSession with relative venv path going up
const session = Project.resolveSession(
  '/home/user/thesis/chapter.md',
  '/home/user/thesis',
  {
    name: 'thesis',
    session: { python: { venv: '../shared-env/.venv', cwd: '.', name: 'shared' } }
  }
);

console.assert(session.venv === '/home/user/shared-env/.venv');
console.log('✓ resolveSession resolves relative paths correctly');
```

---

### 1.6 Project.getDefaults

Return default configuration values.

```javascript
// Test: getDefaults returns sensible defaults
const defaults = Project.getDefaults();

console.assert(defaults.session.python.venv === '.venv');
console.assert(defaults.session.python.cwd === '.');
console.assert(defaults.session.python.name === 'default');
console.assert(defaults.session.python.auto_start === true);
console.assert(defaults.assets.directory === '_assets');
console.log('✓ getDefaults returns expected defaults');
```

---

## 2. FSML Module

### 2.1 FSML.parsePath

Parse a path into FSML components.

```typescript
interface FSMLPath {
  path: string;           // Original path
  order: number | null;   // Numeric prefix (null if none)
  name: string;           // Name without prefix/extension
  title: string;          // Human-readable title
  extension: string;      // File extension
  isFolder: boolean;
  isHidden: boolean;      // Starts with _
  isSystem: boolean;      // Starts with .
  depth: number;          // Nesting level from project root
  parent: string;         // Parent directory path
}

function parsePath(relativePath: string): FSMLPath
```

```javascript
// Test: parsePath with numbered file
const p = FSML.parsePath('02-getting-started/01-installation.md');

console.assert(p.order === 1);
console.assert(p.name === 'installation');
console.assert(p.title === 'Installation');
console.assert(p.isFolder === false);
console.assert(p.isHidden === false);
console.assert(p.depth === 1);
console.assert(p.parent === '02-getting-started');
console.log('✓ parsePath parses numbered file correctly');
```

```javascript
// Test: parsePath with unnumbered file
const p = FSML.parsePath('appendix.md');

console.assert(p.order === null);
console.assert(p.name === 'appendix');
console.assert(p.title === 'Appendix');
console.assert(p.depth === 0);
console.log('✓ parsePath handles unnumbered files');
```

```javascript
// Test: parsePath with hidden folder
const p = FSML.parsePath('_assets/images/diagram.png');

console.assert(p.isHidden === true);
console.assert(p.isSystem === false);
console.log('✓ parsePath detects hidden folders');
```

```javascript
// Test: parsePath with system folder
const p = FSML.parsePath('.git/config');

console.assert(p.isHidden === false);
console.assert(p.isSystem === true);
console.log('✓ parsePath detects system folders');
```

```javascript
// Test: parsePath title derivation with hyphens and underscores
console.assert(FSML.parsePath('getting-started.md').title === 'Getting Started');
console.assert(FSML.parsePath('getting_started.md').title === 'Getting Started');
console.assert(FSML.parsePath('01-my-cool-doc.md').title === 'My Cool Doc');
console.log('✓ parsePath derives titles correctly');
```

---

### 2.2 FSML.sortPaths

Sort paths according to FSML rules.

```typescript
function sortPaths(paths: string[]): string[]
```

**Rules:**
1. Numbered items first, in numeric order
2. Unnumbered items after, alphabetically
3. Folders and files interleaved by their order

```javascript
// Test: sortPaths orders correctly
const paths = [
  'appendix.md',
  '03-results.md',
  '01-intro.md',
  '02-methods/01-setup.md',
  '02-methods/02-analysis.md',
  'README.md',
];

const sorted = FSML.sortPaths(paths);

console.assert(sorted[0] === '01-intro.md');
console.assert(sorted[1] === '02-methods/01-setup.md');
console.assert(sorted[2] === '02-methods/02-analysis.md');
console.assert(sorted[3] === '03-results.md');
// Unnumbered at end, alphabetically
console.assert(sorted[4] === 'appendix.md');
console.assert(sorted[5] === 'README.md');
console.log('✓ sortPaths orders by FSML rules');
```

---

### 2.3 FSML.buildNavTree

Build a navigation tree from sorted paths.

```typescript
interface NavNode {
  path: string;
  title: string;
  order: number | null;
  isFolder: boolean;
  hasIndex: boolean;      // Folder has index.md
  children: NavNode[];
}

function buildNavTree(paths: string[]): NavNode[]
```

```javascript
// Test: buildNavTree creates nested structure
const paths = [
  'mrmd.md',
  '01-intro.md',
  '02-getting-started/index.md',
  '02-getting-started/01-install.md',
  '02-getting-started/02-config.md',
  '03-tutorials/01-basic.md',
  '_assets/image.png',
];

const tree = FSML.buildNavTree(paths);

// mrmd.md should be excluded (it's config, not content)
console.assert(tree.find(n => n.path === 'mrmd.md') === undefined);

// _assets should be excluded (hidden)
console.assert(tree.find(n => n.path === '_assets') === undefined);

// Check structure
const intro = tree.find(n => n.path === '01-intro.md');
console.assert(intro.title === 'Intro');

const gettingStarted = tree.find(n => n.path === '02-getting-started');
console.assert(gettingStarted.isFolder === true);
console.assert(gettingStarted.hasIndex === true);
console.assert(gettingStarted.children.length === 2); // install and config (not index)

const tutorials = tree.find(n => n.path === '03-tutorials');
console.assert(tutorials.hasIndex === false);

console.log('✓ buildNavTree creates correct nested structure');
```

---

### 2.4 FSML.titleFromFilename

Derive a human-readable title from a filename.

```typescript
function titleFromFilename(filename: string): string
```

```javascript
// Test: titleFromFilename
console.assert(FSML.titleFromFilename('01-getting-started.md') === 'Getting Started');
console.assert(FSML.titleFromFilename('my_cool_doc.md') === 'My Cool Doc');
console.assert(FSML.titleFromFilename('README.md') === 'README');
console.assert(FSML.titleFromFilename('index.md') === 'Index');
console.log('✓ titleFromFilename works correctly');
```

---

### 2.5 FSML.computeNewPath

Compute new path when reordering (for drag-drop).

```typescript
function computeNewPath(
  sourcePath: string,
  targetPath: string,
  position: 'before' | 'after' | 'inside'
): { newPath: string; renames: Array<{ from: string; to: string }> }
```

```javascript
// Test: computeNewPath when moving before
const result = FSML.computeNewPath(
  '03-results.md',      // moving this
  '01-intro.md',        // before this
  'before'
);

// 03-results should become 01-results
// 01-intro should become 02-intro
// 02-methods should become 03-methods
console.assert(result.newPath === '01-results.md');
console.assert(result.renames.length >= 1);
console.log('✓ computeNewPath computes renames for reordering');
```

---

## 3. Links Module

### 3.1 Links.parse

Extract all internal links from content.

```typescript
interface ParsedLink {
  raw: string;            // "[[installation]]" or "[[file#heading|text]]"
  target: string;         // "installation" or "file#heading"
  anchor: string | null;  // "heading" or null
  display: string | null; // "text" or null
  start: number;          // Position in content
  end: number;
}

function parse(content: string): ParsedLink[]
```

```javascript
// Test: Links.parse extracts links
const content = `
See [[installation]] for setup.
Check [[getting-started/config#advanced|advanced config]].
Go to [[next]] or [[prev]].
`;

const links = Links.parse(content);

console.assert(links.length === 4);
console.assert(links[0].target === 'installation');
console.assert(links[0].display === null);
console.assert(links[1].target === 'getting-started/config');
console.assert(links[1].anchor === 'advanced');
console.assert(links[1].display === 'advanced config');
console.log('✓ Links.parse extracts all link types');
```

---

### 3.2 Links.resolve

Resolve a link target to an actual file path.

```typescript
function resolve(
  target: string,
  fromDocument: string,
  projectFiles: string[]
): string | null
```

**Resolution rules:**
1. Exact match (with or without .md)
2. Fuzzy match on filename
3. Special links: `[[next]]`, `[[prev]]`, `[[home]]`, `[[up]]`

```javascript
// Test: Links.resolve with exact match
const files = [
  '01-intro.md',
  '02-getting-started/01-installation.md',
  '02-getting-started/02-configuration.md',
];

const resolved = Links.resolve('installation', '01-intro.md', files);
console.assert(resolved === '02-getting-started/01-installation.md');
console.log('✓ Links.resolve finds exact filename match');
```

```javascript
// Test: Links.resolve with path
const resolved = Links.resolve(
  'getting-started/configuration',
  '01-intro.md',
  files
);
console.assert(resolved === '02-getting-started/02-configuration.md');
console.log('✓ Links.resolve handles path-based links');
```

```javascript
// Test: Links.resolve special links
const files = ['01-intro.md', '02-methods.md', '03-results.md'];

console.assert(Links.resolve('next', '01-intro.md', files) === '02-methods.md');
console.assert(Links.resolve('prev', '02-methods.md', files) === '01-intro.md');
console.assert(Links.resolve('home', '03-results.md', files) === '01-intro.md');
console.log('✓ Links.resolve handles special links');
```

---

### 3.3 Links.refactor

Update links in content when files are moved/renamed.

```typescript
interface FileMove {
  from: string;
  to: string;
}

function refactor(
  content: string,
  moves: FileMove[],
  currentDocPath: string
): string
```

```javascript
// Test: Links.refactor updates links
const content = `
See [[installation]] for setup.
Check [[old-name]] for details.
`;

const updated = Links.refactor(content, [
  { from: '02-getting-started/01-installation.md', to: '02-setup/01-installation.md' },
  { from: 'old-name.md', to: 'new-name.md' },
], 'index.md');

console.assert(updated.includes('[[installation]]')); // Still works (fuzzy)
console.assert(updated.includes('[[new-name]]'));
console.log('✓ Links.refactor updates links for moved files');
```

---

## 4. Assets Module

### 4.1 Assets.computeRelativePath

Compute relative path from document to asset.

```typescript
function computeRelativePath(
  documentPath: string,
  assetPath: string
): string
```

```javascript
// Test: Assets.computeRelativePath from root
const rel = Assets.computeRelativePath(
  '01-intro.md',
  '_assets/screenshot.png'
);
console.assert(rel === '_assets/screenshot.png');
console.log('✓ Assets.computeRelativePath from root level');
```

```javascript
// Test: Assets.computeRelativePath from nested doc
const rel = Assets.computeRelativePath(
  '02-getting-started/01-installation.md',
  '_assets/screenshot.png'
);
console.assert(rel === '../_assets/screenshot.png');
console.log('✓ Assets.computeRelativePath from nested document');
```

```javascript
// Test: Assets.computeRelativePath deeply nested
const rel = Assets.computeRelativePath(
  '02-section/sub/deep/doc.md',
  '_assets/img.png'
);
console.assert(rel === '../../../_assets/img.png');
console.log('✓ Assets.computeRelativePath handles deep nesting');
```

---

### 4.2 Assets.refactorPaths

Update asset paths in content when document moves.

```typescript
function refactorPaths(
  content: string,
  oldDocPath: string,
  newDocPath: string,
  assetsDir: string
): string
```

```javascript
// Test: Assets.refactorPaths when doc moves deeper
const content = `
![Screenshot](_assets/screenshot.png)
![Diagram](_assets/diagrams/arch.svg)
`;

const updated = Assets.refactorPaths(
  content,
  '01-intro.md',                          // was at root
  '02-section/01-intro.md',               // moved into section
  '_assets'
);

console.assert(updated.includes('../_assets/screenshot.png'));
console.assert(updated.includes('../_assets/diagrams/arch.svg'));
console.log('✓ Assets.refactorPaths updates paths when doc moves');
```

---

### 4.3 Assets.extractPaths

Extract all asset paths from content.

```typescript
interface AssetReference {
  path: string;
  start: number;
  end: number;
  type: 'image' | 'link';
}

function extractPaths(content: string): AssetReference[]
```

```javascript
// Test: Assets.extractPaths finds all references
const content = `
![Alt](../‌_assets/img.png)
[Download](../_assets/file.pdf)
![Another](_assets/other.jpg)
`;

const refs = Assets.extractPaths(content);

console.assert(refs.length === 3);
console.assert(refs.some(r => r.path.includes('img.png')));
console.assert(refs.some(r => r.type === 'link'));
console.log('✓ Assets.extractPaths finds all asset references');
```

---

## 5. Scaffold Module

### 5.1 Scaffold.project

Generate project scaffold files.

```typescript
interface ScaffoldFile {
  path: string;
  content: string;
}

interface ProjectScaffold {
  files: ScaffoldFile[];
  venvPath: string;
}

function project(name: string): ProjectScaffold
```

```javascript
// Test: Scaffold.project generates correct structure
const scaffold = Scaffold.project('my-research');

const paths = scaffold.files.map(f => f.path);
console.assert(paths.includes('mrmd.md'));
console.assert(paths.includes('01-index.md'));
console.assert(paths.includes('_assets/.gitkeep'));

const mrmdMd = scaffold.files.find(f => f.path === 'mrmd.md');
console.assert(mrmdMd.content.includes('name: "my-research"'));
console.assert(mrmdMd.content.includes('venv: ".venv"'));

console.assert(scaffold.venvPath === '.venv');
console.log('✓ Scaffold.project generates correct structure');
```

---

### 5.2 Scaffold.standaloneFrontmatter

Generate frontmatter for standalone files.

```typescript
function standaloneFrontmatter(config: {
  venv: string;
  cwd: string;
  title?: string;
}): string
```

```javascript
// Test: Scaffold.standaloneFrontmatter
const fm = Scaffold.standaloneFrontmatter({
  venv: '/home/user/.venv',
  cwd: '/home/user/work',
  title: 'Quick Analysis'
});

console.assert(fm.startsWith('---'));
console.assert(fm.includes('title: "Quick Analysis"'));
console.assert(fm.includes('venv: "/home/user/.venv"'));
console.assert(fm.includes('cwd: "/home/user/work"'));
console.assert(fm.endsWith('---\n'));
console.log('✓ Scaffold.standaloneFrontmatter generates valid frontmatter');
```

---

## 6. Search Module

### 6.1 Search.fuzzyMatch

Fuzzy match a query against a string.

```typescript
interface MatchResult {
  score: number;
  matches: number[];  // Indices of matched characters
}

function fuzzyMatch(query: string, target: string): MatchResult
```

```javascript
// Test: Search.fuzzyMatch basic
const result = Search.fuzzyMatch('instal', 'installation');

console.assert(result.score > 0);
console.assert(result.matches.length === 6);
console.assert(result.matches[0] === 0); // 'i' at position 0
console.log('✓ Search.fuzzyMatch matches prefix');
```

```javascript
// Test: Search.fuzzyMatch non-consecutive
const result = Search.fuzzyMatch('ist', 'installation');

console.assert(result.score > 0);
// i(0), s(2), t(6)
console.log('✓ Search.fuzzyMatch handles non-consecutive matches');
```

```javascript
// Test: Search.fuzzyMatch no match
const result = Search.fuzzyMatch('xyz', 'installation');

console.assert(result.score === 0);
console.assert(result.matches.length === 0);
console.log('✓ Search.fuzzyMatch returns 0 for no match');
```

---

### 6.2 Search.files

Search files by full path with scoring.

```typescript
interface SearchResult {
  path: string;
  score: number;
  nameMatches: number[];
  dirMatches: number[];
}

function files(query: string, paths: string[]): SearchResult[]
```

```javascript
// Test: Search.files matches path components
const paths = [
  '/home/user/thesis/README.md',
  '/home/user/thesis/02-methods/analysis.md',
  '/home/user/work/other/README.md',
];

const results = Search.files('thesis readme', paths);

// thesis/README should rank higher than work/README
console.assert(results[0].path.includes('thesis/README'));
console.log('✓ Search.files ranks by path match quality');
```

```javascript
// Test: Search.files empty query returns all
const results = Search.files('', paths);

console.assert(results.length === paths.length);
console.log('✓ Search.files returns all for empty query');
```

---

## 7. Integration Tests

These tests verify the modules work together correctly.

```javascript
// Integration: Full project workflow
const mrmdContent = `# My Thesis

\`\`\`yaml config
name: "My Thesis"
session:
  python:
    venv: ".venv"
\`\`\`
`;

const docContent = `---
title: "GPU Chapter"
session:
  python:
    name: "gpu"
---

# GPU Experiments

See [[installation]] for setup.
![Diagram](_assets/diagram.png)
`;

// 1. Parse project config
const projectConfig = Project.parseConfig(mrmdContent);
console.assert(projectConfig.name === 'My Thesis');

// 2. Parse document frontmatter
const frontmatter = Project.parseFrontmatter(docContent);
console.assert(frontmatter.title === 'GPU Chapter');

// 3. Merge configs
const merged = Project.mergeConfig(projectConfig, frontmatter);
console.assert(merged.session.python.name === 'gpu'); // Doc override

// 4. Resolve session
const session = Project.resolveSession(
  '/home/user/thesis/03-gpu/experiments.md',
  '/home/user/thesis',
  merged
);
console.assert(session.name === 'My Thesis:gpu');
console.assert(session.venv === '/home/user/thesis/.venv');

// 5. Parse links
const links = Links.parse(docContent);
console.assert(links.length === 1);
console.assert(links[0].target === 'installation');

// 6. Extract assets
const assets = Assets.extractPaths(docContent);
console.assert(assets.length === 1);
console.assert(assets[0].path.includes('diagram.png'));

console.log('✓ Integration: Full project workflow works');
```

---

## 8. Type Definitions Summary

```typescript
// Project types
interface ProjectConfig { ... }
interface DocumentFrontmatter { ... }
interface MergedConfig { ... }
interface ResolvedSession { ... }

// FSML types
interface FSMLPath { ... }
interface NavNode { ... }

// Links types
interface ParsedLink { ... }
interface FileMove { ... }

// Assets types
interface AssetReference { ... }

// Scaffold types
interface ScaffoldFile { ... }
interface ProjectScaffold { ... }

// Search types
interface MatchResult { ... }
interface SearchResult { ... }
```

---

## 9. Error Handling

All functions should handle edge cases gracefully:

```javascript
// Test: Empty inputs don't crash
console.assert(Project.parseConfig('') !== undefined);
console.assert(Project.parseFrontmatter('') === null);
console.assert(FSML.parsePath('').name === '');
console.assert(Links.parse('').length === 0);
console.assert(Assets.extractPaths('').length === 0);
console.log('✓ All functions handle empty inputs');
```

```javascript
// Test: Invalid YAML doesn't crash
const config = Project.parseConfig(`
\`\`\`yaml config
invalid: yaml: content: [
\`\`\`
`);
// Should return empty config or partial, not throw
console.assert(config !== undefined);
console.log('✓ Invalid YAML handled gracefully');
```
