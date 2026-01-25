/**
 * Assets module - Asset path computation and refactoring
 *
 * Handles relative paths between documents and assets in _assets/.
 *
 * @module Assets
 */

/**
 * Compute the relative path from a document to an asset
 *
 * @param {string} documentPath - Path of the document (relative to project root)
 * @param {string} assetPath - Path of the asset (relative to project root)
 * @returns {string} Relative path from document to asset
 *
 * @example
 * Assets.computeRelativePath('01-intro.md', '_assets/img.png')
 * // Returns '_assets/img.png'
 *
 * Assets.computeRelativePath('02-section/01-doc.md', '_assets/img.png')
 * // Returns '../_assets/img.png'
 */
export function computeRelativePath(documentPath, assetPath) {
  if (!documentPath || !assetPath) return assetPath || '';

  // Get document directory (remove filename)
  const docDir = documentPath.includes('/')
    ? documentPath.split('/').slice(0, -1).join('/')
    : '';

  // If document is at root, return asset path as-is
  if (!docDir) {
    return assetPath;
  }

  // Count how many levels up we need to go
  const docDepth = docDir.split('/').length;

  // Build the relative path
  const upPath = '../'.repeat(docDepth);
  return upPath + assetPath;
}

/**
 * Update asset paths in content when a document moves
 *
 * @param {string} content - Document content
 * @param {string} oldDocPath - Old document path
 * @param {string} newDocPath - New document path
 * @param {string} assetsDir - Assets directory name (default '_assets')
 * @returns {string} Content with updated asset paths
 *
 * @example
 * Assets.refactorPaths(
 *   '![Img](_assets/img.png)',
 *   '01-intro.md',
 *   '02-section/01-intro.md',
 *   '_assets'
 * )
 * // Returns '![Img](../_assets/img.png)'
 */
export function refactorPaths(content, oldDocPath, newDocPath, assetsDir = '_assets') {
  if (!content) return content;

  // Calculate old and new depths
  const oldDir = oldDocPath.includes('/') ? oldDocPath.split('/').slice(0, -1).join('/') : '';
  const newDir = newDocPath.includes('/') ? newDocPath.split('/').slice(0, -1).join('/') : '';

  const oldDepth = oldDir ? oldDir.split('/').length : 0;
  const newDepth = newDir ? newDir.split('/').length : 0;

  // Find all asset references and update them
  const regex = /(!?)\[([^\]]*)\]\(([^)]+)\)/g;

  return content.replace(regex, (match, bang, alt, path) => {
    // Check if this path references assets
    if (!path.includes(assetsDir)) {
      return match;
    }

    // Extract the asset path relative to project root
    // Old path might be: _assets/img.png or ../_assets/img.png or ../../_assets/img.png
    let assetRelativePath;

    if (path.startsWith(assetsDir)) {
      // Direct path from root: _assets/img.png
      assetRelativePath = path;
    } else if (path.includes('/' + assetsDir)) {
      // Relative path: ../_assets/img.png
      const idx = path.indexOf(assetsDir);
      assetRelativePath = path.slice(idx);
    } else {
      // Can't parse, leave as-is
      return match;
    }

    // Compute new relative path
    const newRelativePath = computeRelativePath(newDocPath, assetRelativePath);

    return `${bang}[${alt}](${newRelativePath})`;
  });
}

/**
 * Extract all asset references from content
 *
 * Finds both image syntax ![](path) and link syntax [](path) that reference assets.
 *
 * @param {string} content - Document content
 * @returns {object[]} Array of asset references
 *
 * @example
 * Assets.extractPaths('![Alt](../_assets/img.png)')
 * // Returns [{ path: '../_assets/img.png', start: 6, end: 26, type: 'image' }]
 */
export function extractPaths(content) {
  if (!content) return [];

  const refs = [];

  // Match both images ![alt](path) and links [text](path)
  // that reference _assets
  const regex = /(!?)\[([^\]]*)\]\(([^)]+)\)/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const isImage = match[1] === '!';
    const path = match[3];

    // Only include paths that look like assets (contain _assets or relative paths to _assets)
    if (path.includes('_assets') || path.includes('assets')) {
      refs.push({
        path,
        start: match.index + match[1].length + match[2].length + 3, // Position of path start
        end: match.index + match[0].length - 1, // Position before closing )
        type: isImage ? 'image' : 'link',
      });
    }
  }

  return refs;
}
