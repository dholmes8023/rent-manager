import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getLandlordSettings, upsertLandlordSettings } from '../services/settings.service.js';

const router = Router();

router.get(
  '/settings',
  asyncHandler(async (req, res) => {
    const settings = await getLandlordSettings();
    res.render('settings', { settings });
  })
);

router.post(
  '/settings',
  asyncHandler(async (req, res) => {
    await upsertLandlordSettings(req.body);
    res.redirect('/settings');
  })
);

export default router;
