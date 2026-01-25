/**
 * Search module - Fuzzy search utilities
 *
 * Provides fuzzy matching for file paths.
 *
 * @module Search
 */

/**
 * Fuzzy match a query against a string
 *
 * @param {string} query - Search query
 * @param {string} target - String to match against
 * @returns {object} Match result with score and matched indices
 *
 * @example
 * Search.fuzzyMatch('instal', 'installation')
 * // Returns { score: 15, matches: [0, 1, 2, 3, 4, 5] }
 *
 * Search.fuzzyMatch('xyz', 'installation')
 * // Returns { score: 0, matches: [] }
 */
export function fuzzyMatch(query, target) {
  if (!query) return { score: 0, matches: [] };

  const queryLower = query.toLowerCase();
  const targetLower = target.toLowerCase();

  let queryIndex = 0;
  let score = 0;
  const matches = [];
  let prevMatchIndex = -1;
  let consecutive = 0;

  for (let i = 0; i < target.length && queryIndex < query.length; i++) {
    if (targetLower[i] === queryLower[queryIndex]) {
      matches.push(i);

      // Scoring
      if (prevMatchIndex === i - 1) {
        // Consecutive match
        consecutive++;
        score += 2 + consecutive;
      } else {
        consecutive = 0;
        score += 1;
      }

      // Bonus for word boundaries
      if (i === 0 || '/._- '.includes(target[i - 1])) {
        score += 5;
      }

      // Bonus for camelCase
      if (i > 0 && target[i] === target[i].toUpperCase() &&
          target[i - 1] === target[i - 1].toLowerCase() &&
          target[i] !== target[i].toLowerCase()) {
        score += 3;
      }

      prevMatchIndex = i;
      queryIndex++;
    }
  }

  // All query characters must match
  if (queryIndex !== query.length) {
    return { score: 0, matches: [] };
  }

  return { score, matches };
}

/**
 * Search files by full path
 *
 * Splits query into tokens and matches each against the path.
 * Results are ranked by match quality.
 *
 * @param {string} query - Search query (space-separated tokens)
 * @param {string[]} paths - Array of file paths
 * @returns {object[]} Search results with scores and match info
 *
 * @example
 * Search.files('thesis readme', ['/home/user/thesis/README.md', '/home/user/other/README.md'])
 * // Returns [
 * //   { path: '/home/user/thesis/README.md', score: 25, ... },
 * //   { path: '/home/user/other/README.md', score: 10, ... }
 * // ]
 */
export function files(query, paths) {
  if (!query.trim()) {
    // Return all files with no scoring
    return paths.map(path => ({
      path,
      score: 0,
      nameMatches: [],
      dirMatches: [],
      ...parsePath(path),
    }));
  }

  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];

  for (const path of paths) {
    const pathLower = path.toLowerCase();
    const { name, dir } = parsePath(path);

    let totalScore = 0;
    let allMatched = true;
    const nameMatches = [];
    const dirMatches = [];

    for (const token of tokens) {
      // Try matching against name first (higher weight)
      const nameResult = fuzzyMatch(token, name);
      if (nameResult.score > 0) {
        totalScore += nameResult.score * 2; // Name matches worth more
        nameMatches.push(...nameResult.matches);
        continue;
      }

      // Try matching against full path
      const pathResult = fuzzyMatch(token, path);
      if (pathResult.score > 0) {
        totalScore += pathResult.score;

        // Split matches into dir and name portions
        const dirLength = path.lastIndexOf('/') + 1;
        for (const idx of pathResult.matches) {
          if (idx < dirLength) {
            dirMatches.push(idx);
          } else {
            nameMatches.push(idx - dirLength);
          }
        }
        continue;
      }

      // Token didn't match
      allMatched = false;
      break;
    }

    if (allMatched && totalScore > 0) {
      results.push({
        path,
        score: totalScore,
        name,
        dir,
        nameMatches: [...new Set(nameMatches)].sort((a, b) => a - b),
        dirMatches: [...new Set(dirMatches)].sort((a, b) => a - b),
      });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results;
}

/**
 * Parse a path into name and directory components
 * @private
 */
function parsePath(path) {
  // Simplify home directory
  const displayPath = path.replace(/^\/home\/[^/]+/, '~');
  const lastSlash = displayPath.lastIndexOf('/');

  return {
    name: lastSlash >= 0 ? displayPath.slice(lastSlash + 1) : displayPath,
    dir: lastSlash >= 0 ? displayPath.slice(0, lastSlash) : '',
  };
}
