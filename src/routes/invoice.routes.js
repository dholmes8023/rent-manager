import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { isValidYyyymm } from '../utils/date.js';
import { formatCurrency } from '../utils/format.js';
import { getRoomById } from '../services/room.service.js';
import { getMeterReading, recalcInvoice } from '../services/invoice.service.js';
import { activeTenant } from '../services/tenant.service.js';

const router = Router();

router.get(
  '/rooms/:id/invoice/:yyyymm',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { yyyymm } = req.params;
    if (!isValidYyyymm(yyyymm)) {
      return res.status(400).send('Tháng không hợp lệ');
    }

    const room = await getRoomById(id);
    if (!room) return res.status(404).send('Không tìm thấy phòng');
    const tenant = await activeTenant(id);
    const meter = await getMeterReading(id, yyyymm);

    const recalc = await recalcInvoice(id, yyyymm);
    if (!recalc) {
      return res.status(400).send('Thiếu chỉ số/thông tin đơn giá tháng này');
    }
    const { invoice, elec_usage, water_usage, tariff } = recalc;

    res.render('invoice', {
      room,
      tenant,
      yyyymm,
      meter,
      elec_usage,
      water_usage,
      subtotal_electricity: invoice.subtotal_electricity,
      subtotal_water: invoice.subtotal_water,
      rent: invoice.rent,
      internet_fee: invoice.internet_fee,
      cleaning_fee: invoice.cleaning_fee,
      total: invoice.total,
      createdAt: invoice.created_at,
      tariff,
      fmt: formatCurrency,
      fmtRaw: formatCurrency,
    });
  })
);

export default router;
