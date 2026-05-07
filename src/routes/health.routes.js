import { Router } from 'express';
import { q } from '../../db.js';

const router = Router();

router.get('/healthz', async (req, res) => {
  try {
    await q('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: err.message });
  }
});

export default router;
