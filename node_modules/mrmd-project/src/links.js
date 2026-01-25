/**
 * Links module - Internal link parsing and resolution
 *
 * Handles [[wiki-style links]] used in mrmd documents.
 *
 * @module Links
 */

/**
 * Parse all internal links from content
 *
 * @param {string} content - Document content
 * @returns {object[]} Array of parsed links
 *
 * @example
 * Links.parse('See [[installation]] and [[config#advanced|advanced config]].')
 * // Returns [
 * //   { raw: '[[installation]]', target: 'installation', anchor: null, display: null, start: 4, end: 20 },
 * //   { raw: '[[config#advanced|advanced config]]', target: 'config', anchor: 'advanced', display: 'advanced config', start: 25, end: 61 }
 * // ]
 */
export function parse(content) {
  if (!content) return [];

  const links = [];
  // Match [[target]], [[target#anchor]], [[target|display]], [[target#anchor|display]]
  const regex = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    links.push({
      raw: match[0],
      target: match[1].trim(),
      anchor: match[2] ? match[2].trim() : null,
      display: match[3] ? match[3].trim() : null,
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return links;
}

/**
 * Resolve a link target to an actual file path
 *
 * Resolution rules:
 * 1. Exact match (with or without .md)
 * 2. Fuzzy match on filename
 * 3. Special links: next, prev, home, up
 *
 * @param {string} target - Link target
 * @param {string} fromDocument - Document containing the link
 * @param {string[]} projectFiles - All files in project
 * @returns {string | null} Resolved path or null
 */
export function resolve(target, fromDocument, projectFiles) {
  if (!target || !projectFiles || projectFiles.length === 0) return null;

  const sortedFiles = [...projectFiles].sort();

  // Handle special links
  const specialLinks = ['next', 'prev', 'home', 'up'];
  if (specialLinks.includes(target.toLowerCase())) {
    return resolveSpecialLink(target.toLowerCase(), fromDocument, sortedFiles);
  }

  // Normalize target (remove .md if present, lowercase for matching)
  const targetNorm = target.replace(/\.md$/, '').toLowerCase();

  // 1. Try exact path match
  for (const file of projectFiles) {
    const fileNorm = file.replace(/\.md$/, '').toLowerCase();
    if (fileNorm === targetNorm || fileNorm === targetNorm + '/index') {
      return file;
    }
  }

  // 2. Try matching just the filename part of target against filenames
  const targetFilename = targetNorm.split('/').pop();
  for (const file of projectFiles) {
    const filename = file.replace(/\.md$/, '').split('/').pop().toLowerCase();
    // Remove numeric prefix for matching
    const filenameNoPrefix = filename.replace(/^\d+-/, '');
    if (filenameNoPrefix === targetFilename || filename === targetFilename) {
      return file;
    }
  }

  // 3. Try fuzzy matching - look for files containing the target name
  for (const file of projectFiles) {
    const fileLower = file.toLowerCase();
    if (fileLower.includes(targetNorm)) {
      return file;
    }
  }

  return null;
}

/**
 * Resolve special links (next, prev, home, up)
 * @private
 */
function resolveSpecialLink(target, fromDocument, sortedFiles) {
  // Filter to only .md files (content files)
  const mdFiles = sortedFiles.filter(f => f.endsWith('.md') && f !== 'mrmd.md');

  // Sort by FSML order
  const sorted = mdFiles.sort((a, b) => {
    const aMatch = a.match(/^(\d+)-/);
    const bMatch = b.match(/^(\d+)-/);
    const aOrder = aMatch ? parseInt(aMatch[1]) : Infinity;
    const bOrder = bMatch ? parseInt(bMatch[1]) : Infinity;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.localeCompare(b);
  });

  const currentIndex = sorted.indexOf(fromDocument);

  switch (target) {
    case 'next':
      return currentIndex >= 0 && currentIndex < sorted.length - 1
        ? sorted[currentIndex + 1]
        : null;

    case 'prev':
      return currentIndex > 0
        ? sorted[currentIndex - 1]
        : null;

    case 'home':
      return sorted[0] || null;

    case 'up': {
      // Go to parent directory's index or first file
      const parts = fromDocument.split('/');
      if (parts.length > 1) {
        const parentDir = parts.slice(0, -1).join('/');
        // Look for index.md in parent
        const parentIndex = sorted.find(f => f === parentDir + '/index.md');
        if (parentIndex) return parentIndex;
        // Or first file in parent
        const parentFile = sorted.find(f => f.startsWith(parentDir + '/'));
        if (parentFile) return parentFile;
      }
      return sorted[0] || null;
    }

    default:
      return null;
  }
}

/**
 * Update links in content when files are moved/renamed
 *
 * @param {string} content - Document content
 * @param {object[]} moves - Array of { from, to } moves
 * @param {string} currentDocPath - Path of document being refactored
 * @returns {string} Content with updated links
 */
export function refactor(content, moves, currentDocPath) {
  if (!content || !moves || moves.length === 0) return content;

  // Build a map of old names to new names
  const renameMap = new Map();
  for (const move of moves) {
    // Extract just the filename without path and extension
    const oldName = move.from.replace(/\.md$/, '').split('/').pop().replace(/^\d+-/, '');
    const newName = move.to.replace(/\.md$/, '').split('/').pop().replace(/^\d+-/, '');
    renameMap.set(oldName.toLowerCase(), newName);
  }

  // Find and replace links
  let result = content;
  const links = parse(content);

  // Process links in reverse order to preserve positions
  for (let i = links.length - 1; i >= 0; i--) {
    const link = links[i];
    const targetName = link.target.split('/').pop().replace(/^\d+-/, '').toLowerCase();

    if (renameMap.has(targetName)) {
      const newName = renameMap.get(targetName);

      // Build new link
      let newLink = `[[${newName}`;
      if (link.anchor) newLink += `#${link.anchor}`;
      if (link.display) newLink += `|${link.display}`;
      newLink += ']]';

      result = result.slice(0, link.start) + newLink + result.slice(link.end);
    }
  }

  return result;
}
