import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { currentYyyymm, isValidYyyymm, prevMonthStr, todayIso } from '../utils/date.js';
import {
  createRoomWithTariff,
  getRoomById,
  listRoomsWithTenant,
  updateRoomWithTariff,
} from '../services/room.service.js';
import {
  getMeterReading,
  getRoomTariff,
  listInvoices,
  recalcInvoice,
  upsertMeterReading,
} from '../services/invoice.service.js';
import { activeTenant, endActiveTenant, startTenant } from '../services/tenant.service.js';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rooms = await listRoomsWithTenant();
    res.render('index', { rooms });
  })
);

router.get('/rooms/new', (req, res) => res.render('room_new'));

router.post(
  '/rooms',
  asyncHandler(async (req, res) => {
    const {
      name,
      note,
      rent,
      internet_fee,
      cleaning_fee,
      electricity_price,
      water_price,
      tenant_full_name,
      tenant_phone,
      tenant_started_at,
    } = req.body;

    const roomId = await createRoomWithTariff({
      name,
      note,
      tariff: { rent, internet_fee, cleaning_fee, electricity_price, water_price },
    });

    if (tenant_full_name && tenant_full_name.trim() !== '') {
      await startTenant(roomId, {
        fullName: tenant_full_name,
        phone: tenant_phone,
        startedAt: tenant_started_at || todayIso(),
      });
    }

    res.redirect(`/rooms/${roomId}`);
  })
);

router.get(
  '/rooms/:id/edit',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const room = await getRoomById(id);
    if (!room) return res.status(404).send('Not found');
    const tariff = await getRoomTariff(id);
    res.render('room_edit', { room, tariff });
  })
);

router.put(
  '/rooms/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { name, note, rent, internet_fee, cleaning_fee, electricity_price, water_price } =
      req.body;
    await updateRoomWithTariff(id, {
      name,
      note,
      tariff: { rent, internet_fee, cleaning_fee, electricity_price, water_price },
    });
    const yyyymm = req.query.yyyymm;
    if (yyyymm && isValidYyyymm(yyyymm)) {
      await recalcInvoice(id, yyyymm);
    }
    res.redirect(`/rooms/${id}`);
  })
);

router.get(
  '/rooms/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const room = await getRoomById(id);
    if (!room) return res.status(404).send('Not found');

    const tenant = await activeTenant(id);
    const tariff = await getRoomTariff(id);
    const yyyymm = isValidYyyymm(req.query.yyyymm) ? req.query.yyyymm : currentYyyymm();
    const meter = await getMeterReading(id, yyyymm);

    let prefill = null;
    let prevYyyymm = null;
    if (!meter) {
      prevYyyymm = prevMonthStr(yyyymm);
      const prev = await getMeterReading(id, prevYyyymm);
      if (prev) prefill = { elec_start: prev.elec_end, water_start: prev.water_end };
    }

    const invoices = await listInvoices(id);
    const hasCompleteMeter = !!(
      meter &&
      Number(meter.elec_end) >= Number(meter.elec_start) &&
      Number(meter.water_end) >= Number(meter.water_start)
    );

    res.render('room', {
      room,
      tenant,
      tariff,
      yyyymm,
      meter,
      invoices,
      prefill,
      prevYyyymm,
      hasCompleteMeter,
    });
  })
);

router.post(
  '/rooms/:id/tenant',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { full_name, phone, started_at } = req.body;
    await endActiveTenant(id, todayIso());
    await startTenant(id, {
      fullName: full_name,
      phone,
      startedAt: started_at || todayIso(),
    });
    res.redirect(`/rooms/${id}`);
  })
);

router.post(
  '/rooms/:id/tenant/end',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await endActiveTenant(id, todayIso());
    res.redirect(`/rooms/${id}`);
  })
);

router.post(
  '/rooms/:id/meter',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const yyyymm = req.body.yyyymm;
    if (!isValidYyyymm(yyyymm)) {
      return res.status(400).send('Tháng không hợp lệ');
    }
    const { elec_end, water_end } = req.body;
    let { elec_start, water_start } = req.body;

    if (elec_start === '' || water_start === '') {
      const prev = await getMeterReading(id, prevMonthStr(yyyymm));
      if (prev) {
        if (elec_start === '') elec_start = prev.elec_end;
        if (water_start === '') water_start = prev.water_end;
      }
    }

    if (Number(elec_end) < Number(elec_start) || Number(water_end) < Number(water_start)) {
      return res.status(400).send('Chỉ số cuối phải >= chỉ số đầu');
    }

    await upsertMeterReading(id, yyyymm, { elec_start, elec_end, water_start, water_end });
    await recalcInvoice(id, yyyymm);
    res.redirect(`/rooms/${id}?yyyymm=${yyyymm}`);
  })
);

export default router;
