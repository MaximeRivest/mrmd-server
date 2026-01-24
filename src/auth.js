/**
 * Token-based authentication
 */

import crypto from 'crypto';

/**
 * Generate a random token
 * @returns {string}
 */
export function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Create authentication middleware
 * @param {string} validToken - The valid token
 * @param {boolean} noAuth - If true, skip auth
 */
export function createAuthMiddleware(validToken, noAuth = false) {
  return (req, res, next) => {
    if (noAuth) {
      return next();
    }

    // Check for token in query string, header, or cookie
    const token =
      req.query.token ||
      req.headers.authorization?.replace('Bearer ', '') ||
      req.headers['x-token'] ||
      req.cookies?.token;

    if (!token) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Provide token via ?token=, Authorization header, or X-Token header',
      });
    }

    if (token !== validToken) {
      return res.status(403).json({
        error: 'Invalid token',
      });
    }

    next();
  };
}

/**
 * Validate token for WebSocket connections
 * @param {string} providedToken
 * @param {string} validToken
 * @param {boolean} noAuth
 * @returns {boolean}
 */
export function validateWsToken(providedToken, validToken, noAuth) {
  if (noAuth) return true;
  return providedToken === validToken;
}
