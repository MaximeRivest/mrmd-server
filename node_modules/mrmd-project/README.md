# mrmd-project

Pure logic for understanding mrmd project structure and conventions.

This package provides zero-side-effect functions for parsing project configuration, building navigation trees, resolving internal links, and managing asset paths in [mrmd](https://github.com/anthropics/mrmd) markdown notebook projects.

## Installation

```bash
npm install mrmd-project
```

## Features

- **Zero I/O** - All functions are pure; no file system access
- **Project Config** - Parse `mrmd.md` files with `yaml config` blocks
- **FSML** - Filesystem Markup Language for navigation trees
- **Internal Links** - Parse and resolve `[[wiki-style]]` links
- **Asset Paths** - Compute relative paths between documents and assets
- **Search** - Fuzzy matching for file picker functionality

## Usage

```javascript
import { Project, FSML, Links, Assets, Scaffold, Search } from 'mrmd-project';
```

### Project Configuration

Parse project config from `mrmd.md` files:

```javascript
const mrmdContent = `# My Project

\`\`\`yaml config
name: "My Thesis"
session:
  python:
    venv: ".venv"
\`\`\`
`;

const config = Project.parseConfig(mrmdContent);
// { name: 'My Thesis', session: { python: { venv: '.venv' } } }
```

Parse document frontmatter:

```javascript
const docContent = `---
title: "Chapter 1"
session:
  python:
    name: "gpu-session"
---

# Content here
`;

const frontmatter = Project.parseFrontmatter(docContent);
// { title: 'Chapter 1', session: { python: { name: 'gpu-session' } } }
```

Merge configs (document overrides project):

```javascript
const merged = Project.mergeConfig(projectConfig, frontmatter);
```

Resolve session configuration:

```javascript
const session = Project.resolveSession(
  '/home/user/thesis/chapter.md',  // document path
  '/home/user/thesis',              // project root
  merged                            // merged config
);
// {
//   name: 'my-thesis:gpu-session',
//   venv: '/home/user/thesis/.venv',
//   cwd: '/home/user/thesis',
//   autoStart: true
// }
```

Find project root:

```javascript
const root = Project.findRoot(
  '/home/user/thesis/chapter/doc.md',
  (path) => fs.existsSync(path + '/mrmd.md')
);
// '/home/user/thesis'
```

### FSML (Filesystem Markup Language)

Parse paths into components:

```javascript
const parsed = FSML.parsePath('02-getting-started/01-installation.md');
// {
//   path: '02-getting-started/01-installation.md',
//   order: 1,
//   name: 'installation',
//   title: 'Installation',
//   extension: '.md',
//   isFolder: false,
//   isHidden: false,
//   isSystem: false,
//   depth: 1,
//   parent: '02-getting-started'
// }
```

Sort paths by FSML rules:

```javascript
const sorted = FSML.sortPaths([
  'appendix.md',
  '03-results.md',
  '01-intro.md',
  '02-methods.md',
]);
// ['01-intro.md', '02-methods.md', '03-results.md', 'appendix.md']
```

Build navigation tree:

```javascript
const tree = FSML.buildNavTree([
  '01-intro.md',
  '02-getting-started/index.md',
  '02-getting-started/01-install.md',
  '02-getting-started/02-config.md',
]);
// [
//   { path: '01-intro.md', title: 'Intro', isFolder: false, children: [] },
//   { path: '02-getting-started', title: 'Getting Started', isFolder: true, hasIndex: true, children: [...] }
// ]
```

Derive titles from filenames:

```javascript
FSML.titleFromFilename('01-getting-started.md'); // 'Getting Started'
FSML.titleFromFilename('my_cool_doc.md');        // 'My Cool Doc'
```

### Internal Links

Parse wiki-style links:

```javascript
const links = Links.parse('See [[installation]] and [[config#advanced|advanced config]].');
// [
//   { raw: '[[installation]]', target: 'installation', anchor: null, display: null, ... },
//   { raw: '[[config#advanced|advanced config]]', target: 'config', anchor: 'advanced', display: 'advanced config', ... }
// ]
```

Resolve links to files:

```javascript
const files = ['01-intro.md', '02-getting-started/01-installation.md'];
const resolved = Links.resolve('installation', '01-intro.md', files);
// '02-getting-started/01-installation.md'

// Special links
Links.resolve('next', '01-intro.md', files);  // next document in order
Links.resolve('prev', '02-methods.md', files); // previous document
Links.resolve('home', 'any.md', files);        // first document
```

Refactor links when files move:

```javascript
const updated = Links.refactor(
  'See [[old-name]] for details.',
  [{ from: 'old-name.md', to: 'new-name.md' }],
  'index.md'
);
// 'See [[new-name]] for details.'
```

### Asset Paths

Compute relative paths from documents to assets:

```javascript
Assets.computeRelativePath('01-intro.md', '_assets/img.png');
// '_assets/img.png'

Assets.computeRelativePath('02-section/01-doc.md', '_assets/img.png');
// '../_assets/img.png'

Assets.computeRelativePath('02-section/sub/deep/doc.md', '_assets/img.png');
// '../../../_assets/img.png'
```

Refactor paths when documents move:

```javascript
const content = '![Screenshot](_assets/screenshot.png)';
const updated = Assets.refactorPaths(
  content,
  '01-intro.md',           // old location
  '02-section/01-intro.md', // new location
  '_assets'
);
// '![Screenshot](../_assets/screenshot.png)'
```

Extract asset references:

```javascript
const refs = Assets.extractPaths('![Alt](../_assets/img.png)');
// [{ path: '../_assets/img.png', type: 'image', start: 6, end: 25 }]
```

### Scaffolding

Generate new project scaffold:

```javascript
const scaffold = Scaffold.project('my-research');
// {
//   files: [
//     { path: 'mrmd.md', content: '...' },
//     { path: '01-index.md', content: '...' },
//     { path: '_assets/.gitkeep', content: '' }
//   ],
//   venvPath: '.venv'
// }
```

Generate standalone file frontmatter:

```javascript
const frontmatter = Scaffold.standaloneFrontmatter({
  venv: '/home/user/.venv',
  cwd: '/home/user/work',
  title: 'Quick Analysis'
});
// '---\ntitle: "Quick Analysis"\nsession:\n  python:\n    venv: "/home/user/.venv"\n    cwd: "/home/user/work"\n---\n'
```

### Search

Fuzzy match strings:

```javascript
const result = Search.fuzzyMatch('instal', 'installation');
// { score: 15, matches: [0, 1, 2, 3, 4, 5] }
```

Search files by path:

```javascript
const results = Search.files('thesis readme', [
  '/home/user/thesis/README.md',
  '/home/user/other/README.md',
]);
// Ranked by match quality, thesis/README.md first
```

## FSML Conventions

FSML (Filesystem Markup Language) treats the filesystem as markup:

| Pattern | Example | Meaning |
|---------|---------|---------|
| `NN-name` | `01-intro.md` | Ordered item (position 1) |
| No prefix | `appendix.md` | Unordered (sorted alphabetically after numbered) |
| `_folder/` | `_assets/` | Hidden from navigation (author-only) |
| `.folder/` | `.git/` | System folder (ignored) |
| `index.md` | `02-section/index.md` | Section landing page |
| `mrmd.md` | Root `mrmd.md` | Project configuration file |

## API Reference

### Project Module

| Function | Description |
|----------|-------------|
| `parseConfig(content)` | Extract and merge `yaml config` blocks |
| `parseFrontmatter(content)` | Extract YAML frontmatter |
| `mergeConfig(project, doc)` | Deep merge configs (doc wins) |
| `findRoot(path, hasFile)` | Walk up to find project root |
| `resolveSession(doc, root, config)` | Compute session with absolute paths |
| `getDefaults()` | Get default configuration values |

### FSML Module

| Function | Description |
|----------|-------------|
| `parsePath(path)` | Parse path into FSML components |
| `sortPaths(paths)` | Sort by FSML rules |
| `buildNavTree(paths)` | Build nested navigation structure |
| `titleFromFilename(name)` | Derive human-readable title |
| `computeNewPath(src, target, pos)` | Compute path for reordering |

### Links Module

| Function | Description |
|----------|-------------|
| `parse(content)` | Extract all `[[links]]` |
| `resolve(target, from, files)` | Resolve link to file path |
| `refactor(content, moves, doc)` | Update links after file moves |

### Assets Module

| Function | Description |
|----------|-------------|
| `computeRelativePath(doc, asset)` | Get relative path to asset |
| `refactorPaths(content, old, new, dir)` | Update paths after doc moves |
| `extractPaths(content)` | Find all asset references |

### Scaffold Module

| Function | Description |
|----------|-------------|
| `project(name)` | Generate project scaffold |
| `standaloneFrontmatter(config)` | Generate standalone frontmatter |

### Search Module

| Function | Description |
|----------|-------------|
| `fuzzyMatch(query, target)` | Fuzzy match with scoring |
| `files(query, paths)` | Search and rank file paths |

## License

MIT
