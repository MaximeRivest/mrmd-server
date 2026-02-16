/**
 * Deprecated session API routes.
 *
 * Runtime lifecycle is now process-centric and served under /api/runtime.
 * This file is intentionally retained only as an explicit tombstone.
 */

import { Router } from 'express';

export function createSessionRoutes() {
  const router = Router();

  router.use((req, res) => {
    res.status(410).json({
      error: 'Session API removed. Use /api/runtime endpoints.',
      replacement: '/api/runtime',
    });
  });

  return router;
}
