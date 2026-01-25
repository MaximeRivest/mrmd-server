/**
 * Scaffold module - Project and document templates
 *
 * Generates scaffolding content for new projects and standalone files.
 *
 * @module Scaffold
 */

/**
 * Generate project scaffold
 *
 * @param {string} name - Project name
 * @returns {object} Scaffold with files array and venvPath
 *
 * @example
 * Scaffold.project('my-research')
 * // Returns {
 * //   files: [
 * //     { path: 'mrmd.md', content: '# my-research\n...' },
 * //     { path: '01-index.md', content: '# my-research\n...' },
 * //     { path: '_assets/.gitkeep', content: '' }
 * //   ],
 * //   venvPath: '.venv'
 * // }
 */
export function project(name) {
  const safeName = name.replace(/[^a-zA-Z0-9-_]/g, '-');

  const mrmdMd = `# ${name}

Welcome to your new mrmd project.

## Configuration

\`\`\`yaml config
name: "${name}"
\`\`\`

## Session Setup

We use a shared session for all documents in this project.

\`\`\`yaml config
session:
  python:
    venv: ".venv"
    cwd: "."
    name: "default"
    auto_start: true
\`\`\`

## Getting Started

- Edit this file to configure your project
- Create new documents with \`Ctrl+P\`
- Run code blocks with \`Ctrl+Enter\`

## Environment Check

\`\`\`python
import sys
print(f"Python: {sys.version}")
print(f"Working directory: {__import__('os').getcwd()}")
\`\`\`
`;

  const indexMd = `# ${name}

This is your project's main document.

## Quick Start

\`\`\`python
print("Hello from mrmd!")
\`\`\`

## Project Structure

| Path | Purpose |
|------|---------|
| \`mrmd.md\` | Project configuration |
| \`_assets/\` | Images and data files |
| \`.venv/\` | Python environment |

## Next Steps

- Create new documents with \`Ctrl+P\`
- Organize with folders: \`02-section/01-document.md\`
- Add images to \`_assets/\` and reference with \`![](_assets/image.png)\`
`;

  return {
    files: [
      { path: 'mrmd.md', content: mrmdMd },
      { path: '01-index.md', content: indexMd },
      { path: '_assets/.gitkeep', content: '' },
    ],
    venvPath: '.venv',
  };
}

/**
 * Generate frontmatter for standalone files
 *
 * @param {object} config - Configuration
 * @param {string} config.venv - Absolute path to venv
 * @param {string} config.cwd - Absolute path to working directory
 * @param {string} [config.title] - Optional title
 * @returns {string} YAML frontmatter string
 *
 * @example
 * Scaffold.standaloneFrontmatter({
 *   venv: '/home/user/.venv',
 *   cwd: '/home/user/work',
 *   title: 'Quick Analysis'
 * })
 * // Returns '---\ntitle: "Quick Analysis"\nsession:\n  python:\n    venv: "/home/user/.venv"\n    cwd: "/home/user/work"\n---\n'
 */
export function standaloneFrontmatter(config) {
  const { venv, cwd, title } = config;

  let yaml = '---\n';

  if (title) {
    yaml += `title: "${title}"\n`;
  }

  yaml += `session:
  python:
    venv: "${venv}"
    cwd: "${cwd}"
---
`;

  return yaml;
}
