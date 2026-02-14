/**
 * User info API — exposes the logged-in user's identity in cloud mode.
 * Data comes from environment variables set by the orchestrator.
 */

import { Router } from 'express';

export function createUserRoutes() {
  const router = Router();

  // GET /api/user/me — return current user info (cloud mode only)
  router.get('/me', (req, res) => {
    const cloudMode = process.env.CLOUD_MODE === '1';
    if (!cloudMode) {
      return res.status(404).json({ error: 'Not in cloud mode' });
    }

    res.json({
      id: process.env.CLOUD_USER_ID || null,
      name: process.env.CLOUD_USER_NAME || null,
      email: process.env.CLOUD_USER_EMAIL || null,
      avatar_url: process.env.CLOUD_USER_AVATAR || null,
      plan: process.env.CLOUD_USER_PLAN || 'free',
    });
  });

  return router;
}
