/**
 * FSML module - Filesystem Markup Language utilities
 *
 * Handles path parsing, sorting, and navigation tree building
 * according to FSML conventions.
 *
 * @module FSML
 */

/**
 * Parse a relative path into FSML components
 *
 * @param {string} relativePath - Path relative to project root
 * @returns {object} Parsed path information
 *
 * @example
 * FSML.parsePath('02-getting-started/01-installation.md')
 * // Returns {
 * //   path: '02-getting-started/01-installation.md',
 * //   order: 1,
 * //   name: 'installation',
 * //   title: 'Installation',
 * //   extension: '.md',
 * //   isFolder: false,
 * //   isHidden: false,
 * //   isSystem: false,
 * //   depth: 1,
 * //   parent: '02-getting-started'
 * // }
 */
export function parsePath(relativePath) {
  if (!relativePath) {
    return {
      path: '',
      order: null,
      name: '',
      title: '',
      extension: '',
      isFolder: false,
      isHidden: false,
      isSystem: false,
      depth: 0,
      parent: '',
    };
  }

  // Normalize path (remove trailing slash)
  const path = relativePath.replace(/\/+$/, '');

  // Get segments
  const segments = path.split('/').filter(Boolean);
  const depth = segments.length - 1;
  const parent = segments.slice(0, -1).join('/');

  // Get filename (last segment)
  const filename = segments[segments.length - 1] || '';

  // Check if it's a folder (no extension or explicitly ends with /)
  const hasExtension = /\.[^./]+$/.test(filename);
  const isFolder = !hasExtension;

  // Get extension
  const extMatch = filename.match(/(\.[^.]+)$/);
  const extension = extMatch ? extMatch[1] : '';

  // Get name without extension
  const nameWithoutExt = filename.replace(/\.[^.]+$/, '');

  // Parse numeric prefix (e.g., "01-" or "02_")
  const prefixMatch = nameWithoutExt.match(/^(\d+)[-_]/);
  const order = prefixMatch ? parseInt(prefixMatch[1], 10) : null;

  // Get name without prefix
  const name = prefixMatch ? nameWithoutExt.replace(/^\d+[-_]/, '') : nameWithoutExt;

  // Derive title
  const title = titleFromFilename(filename);

  // Check hidden/system status based on first segment
  const firstSegment = segments[0] || filename;
  const isHidden = firstSegment.startsWith('_');
  const isSystem = firstSegment.startsWith('.');

  return {
    path,
    order,
    name,
    title,
    extension,
    isFolder,
    isHidden,
    isSystem,
    depth,
    parent,
  };
}

/**
 * Sort paths according to FSML rules
 *
 * Rules:
 * 1. Numbered items first, in numeric order
 * 2. Unnumbered items after, alphabetically
 * 3. Folders and files interleaved by their order
 *
 * @param {string[]} paths - Array of relative paths
 * @returns {string[]} Sorted paths
 */
export function sortPaths(paths) {
  if (!paths || paths.length === 0) return [];

  // Parse all paths
  const parsed = paths.map(p => ({
    path: p,
    ...parsePath(p),
  }));

  // Sort function
  return parsed
    .sort((a, b) => {
      // First, compare by parent path to keep hierarchy
      const aParts = a.path.split('/');
      const bParts = b.path.split('/');

      // Compare common ancestor parts
      const minLen = Math.min(aParts.length, bParts.length);

      for (let i = 0; i < minLen; i++) {
        const aPart = aParts[i];
        const bPart = bParts[i];

        if (aPart === bPart) continue;

        // Parse parts for comparison
        const aPartParsed = parsePath(aPart);
        const bPartParsed = parsePath(bPart);

        // Numbered items first
        if (aPartParsed.order !== null && bPartParsed.order !== null) {
          return aPartParsed.order - bPartParsed.order;
        }
        if (aPartParsed.order !== null) return -1;
        if (bPartParsed.order !== null) return 1;

        // Alphabetical for unnumbered
        return aPart.localeCompare(bPart);
      }

      // Shorter paths (parents) come before longer paths (children) -- actually not, children should come after parent
      return aParts.length - bParts.length;
    })
    .map(p => p.path);
}

/**
 * Build a navigation tree from sorted paths
 *
 * @param {string[]} paths - Array of relative paths
 * @returns {object[]} Navigation tree nodes
 *
 * @example
 * FSML.buildNavTree(['01-intro.md', '02-methods/01-setup.md', '02-methods/02-analysis.md'])
 * // Returns [
 * //   { path: '01-intro.md', title: 'Intro', isFolder: false, children: [] },
 * //   { path: '02-methods', title: 'Methods', isFolder: true, hasIndex: false, children: [...] }
 * // ]
 */
export function buildNavTree(paths) {
  if (!paths || paths.length === 0) return [];

  // Filter out mrmd.md, hidden (_), and system (.) paths
  const filtered = paths.filter(p => {
    const parsed = parsePath(p);
    if (parsed.isHidden || parsed.isSystem) return false;
    // Exclude mrmd.md at root
    if (p === 'mrmd.md') return false;
    return true;
  });

  // Sort the paths
  const sorted = sortPaths(filtered);

  // Build folder structure first - collect all unique folders
  const folders = new Map(); // folder path -> { hasIndex, children: [] }
  const rootChildren = [];

  // First pass: identify folders and track index.md
  for (const path of sorted) {
    const segments = path.split('/');

    // Track folder hierarchy
    for (let i = 0; i < segments.length - 1; i++) {
      const folderPath = segments.slice(0, i + 1).join('/');
      if (!folders.has(folderPath)) {
        const parsed = parsePath(folderPath);
        folders.set(folderPath, {
          path: folderPath,
          title: titleFromFilename(segments[i]),
          order: parsed.order,
          isFolder: true,
          hasIndex: false,
          children: [],
        });
      }
    }

    // Check if this is an index.md
    const filename = segments[segments.length - 1];
    if (filename === 'index.md' && segments.length > 1) {
      const parentPath = segments.slice(0, -1).join('/');
      if (folders.has(parentPath)) {
        folders.get(parentPath).hasIndex = true;
      }
    }
  }

  // Second pass: build tree
  for (const path of sorted) {
    const segments = path.split('/');
    const filename = segments[segments.length - 1];

    // Skip index.md files (they're represented by the folder itself)
    if (filename === 'index.md') continue;

    const parsed = parsePath(path);

    const node = {
      path,
      title: parsed.title,
      order: parsed.order,
      isFolder: false,
      hasIndex: false,
      children: [],
    };

    if (segments.length === 1) {
      // Top-level file
      rootChildren.push(node);
    } else {
      // File in a folder
      const parentPath = segments.slice(0, -1).join('/');
      if (folders.has(parentPath)) {
        folders.get(parentPath).children.push(node);
      }
    }
  }

  // Third pass: add folders to tree
  // Sort folders by depth (shallow first) to build hierarchy
  const folderList = Array.from(folders.values());
  folderList.sort((a, b) => a.path.split('/').length - b.path.split('/').length);

  for (const folder of folderList) {
    const segments = folder.path.split('/');

    if (segments.length === 1) {
      // Top-level folder
      rootChildren.push(folder);
    } else {
      // Nested folder
      const parentPath = segments.slice(0, -1).join('/');
      if (folders.has(parentPath)) {
        folders.get(parentPath).children.push(folder);
      }
    }
  }

  // Sort root children
  rootChildren.sort((a, b) => {
    if (a.order !== null && b.order !== null) return a.order - b.order;
    if (a.order !== null) return -1;
    if (b.order !== null) return 1;
    return a.title.localeCompare(b.title);
  });

  // Sort children of each folder
  for (const folder of folders.values()) {
    folder.children.sort((a, b) => {
      if (a.order !== null && b.order !== null) return a.order - b.order;
      if (a.order !== null) return -1;
      if (b.order !== null) return 1;
      return a.title.localeCompare(b.title);
    });
  }

  return rootChildren;
}

/**
 * Derive a human-readable title from a filename
 *
 * @param {string} filename - Filename (with or without extension)
 * @returns {string} Human-readable title
 *
 * @example
 * FSML.titleFromFilename('01-getting-started.md') // 'Getting Started'
 * FSML.titleFromFilename('my_cool_doc.md')        // 'My Cool Doc'
 */
export function titleFromFilename(filename) {
  if (!filename) return '';

  // Remove extension
  let name = filename.replace(/\.[^.]+$/, '');

  // Remove numeric prefix (e.g., "01-" or "02_")
  name = name.replace(/^\d+-/, '');

  // Replace hyphens and underscores with spaces
  name = name.replace(/[-_]/g, ' ');

  // Title case: capitalize first letter of each word
  name = name
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  return name;
}

/**
 * Compute new paths when reordering files
 *
 * @param {string} sourcePath - Path being moved
 * @param {string} targetPath - Path to move relative to
 * @param {'before' | 'after' | 'inside'} position - Where to place
 * @returns {object} New path and required renames
 */
export function computeNewPath(sourcePath, targetPath, position) {
  const source = parsePath(sourcePath);
  const target = parsePath(targetPath);

  // Get target directory
  let targetDir = '';
  if (position === 'inside') {
    // Moving inside a folder
    targetDir = targetPath;
  } else {
    // Moving before/after a file or folder
    targetDir = target.parent;
  }

  // Determine the new order number
  let newOrder;
  if (position === 'before') {
    // Take the target's order
    newOrder = target.order || 1;
  } else if (position === 'after') {
    newOrder = (target.order || 0) + 1;
  } else {
    // Inside: use order 1
    newOrder = 1;
  }

  // Build new filename
  const paddedOrder = String(newOrder).padStart(2, '0');
  const newFilename = `${paddedOrder}-${source.name}${source.extension}`;
  const newPath = targetDir ? `${targetDir}/${newFilename}` : newFilename;

  // Calculate renames needed (simplified - just returns the main rename)
  const renames = [];

  // The source file rename
  if (sourcePath !== newPath) {
    renames.push({ from: sourcePath, to: newPath });
  }

  return {
    newPath,
    renames,
  };
}
