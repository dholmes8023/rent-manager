
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import methodOverride from 'method-override';
import dayjs from 'dayjs';
import { q, migrate } from './db.js';
import dotenv from 'dotenv';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(methodOverride('_method'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// helpers
async function activeTenant(roomId) {
  const { rows } = await q(`
    SELECT * FROM tenants
    WHERE room_id = $1 AND ended_at IS NULL
    ORDER BY started_at DESC LIMIT 1
  `, [roomId]);
  return rows[0] || null;
}
async function roomTariff(roomId) {
  const { rows } = await q(`SELECT * FROM tariffs WHERE room_id = $1`, [roomId]);
  return rows[0] || null;
}
function prevMonthStr(yyyymm) {
  const y = Number(yyyymm.slice(0,4));
  const m = Number(yyyymm.slice(4,6));
  const date = dayjs(`${y}-${m}-01`).subtract(1,'month');
  return date.format('YYYYMM');
}

async function recalcInvoice(roomId, yyyymm) {
  const tariff = (await q(`SELECT * FROM tariffs WHERE room_id=$1`, [roomId])).rows[0];
  const meter  = (await q(`SELECT * FROM meter_readings WHERE room_id=$1 AND yyyymm=$2`, [roomId, yyyymm])).rows[0];
  if (!tariff || !meter) return null; // chưa đủ dữ liệu

  const elec_usage = Number((meter.elec_end - meter.elec_start).toFixed(2));
  const water_usage = Number((meter.water_end - meter.water_start).toFixed(2));
  const subtotal_electricity = Math.round(elec_usage * tariff.electricity_price);
  const subtotal_water       = Math.round(water_usage * tariff.water_price);
  const total = tariff.rent + tariff.internet_fee + tariff.cleaning_fee + subtotal_electricity + subtotal_water;

  const { rows } = await q(`
    INSERT INTO invoices (room_id, yyyymm, subtotal_electricity, subtotal_water, rent, internet_fee, cleaning_fee, total)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (room_id, yyyymm) DO UPDATE SET
      subtotal_electricity = EXCLUDED.subtotal_electricity,
      subtotal_water       = EXCLUDED.subtotal_water,
      rent                 = EXCLUDED.rent,
      internet_fee         = EXCLUDED.internet_fee,
      cleaning_fee         = EXCLUDED.cleaning_fee,
      total                = EXCLUDED.total,
      created_at           = NOW()
    RETURNING *;
  `, [roomId, yyyymm, subtotal_electricity, subtotal_water, tariff.rent, tariff.internet_fee, tariff.cleaning_fee, total]);

  return { invoice: rows[0], elec_usage, water_usage, tariff };
}

// routes
app.get('/', async (req, res) => {
  const { rows } = await q(`
    SELECT r.*, (SELECT full_name FROM tenants t
      WHERE t.room_id = r.id AND t.ended_at IS NULL
      ORDER BY started_at DESC LIMIT 1) AS tenant
    FROM rooms r ORDER BY r.id
  `);
  res.render('index', { rooms: rows });
});

// settings
app.get('/settings', async (req, res) => {
  const { rows } = await q(`SELECT * FROM landlord_settings WHERE id=1`);
  res.render('settings', { settings: rows[0] || {} });
});
app.post('/settings', async (req, res) => {
  const { owner_name, phone, address, bank_name, bank_account } = req.body;
  await q(`
    INSERT INTO landlord_settings (id, owner_name, phone, address, bank_name, bank_account)
    VALUES (1, $1, $2, $3, $4, $5)
    ON CONFLICT (id) DO UPDATE SET
      owner_name = EXCLUDED.owner_name,
      phone = EXCLUDED.phone,
      address = EXCLUDED.address,
      bank_name = EXCLUDED.bank_name,
      bank_account = EXCLUDED.bank_account
  `, [owner_name, phone, address, bank_name, bank_account]);
  res.redirect('/settings');
});

// create room
app.get('/rooms/new', (req, res) => res.render('room_new'));
app.post('/rooms', async (req, res) => {
  const { name, note, rent, internet_fee, cleaning_fee, electricity_price, water_price,
          tenant_full_name, tenant_phone, tenant_started_at } = req.body;
  const { rows } = await q(`INSERT INTO rooms (name, note) VALUES ($1,$2) RETURNING id`, [name, note || null]);
  const roomId = rows[0].id;
  await q(`INSERT INTO tariffs (room_id, rent, internet_fee, cleaning_fee, electricity_price, water_price)
           VALUES ($1,$2,$3,$4,$5,$6)`,
           [roomId, Number(rent), Number(internet_fee), Number(cleaning_fee), Number(electricity_price), Number(water_price)]);
  if (tenant_full_name && tenant_full_name.trim() !== '') {
    await q(`INSERT INTO tenants (room_id, full_name, phone, started_at, ended_at)
             VALUES ($1,$2,$3,$4,NULL)`,
             [roomId, tenant_full_name.trim(), tenant_phone || null, tenant_started_at || dayjs().format('YYYY-MM-DD')]);
  }
  res.redirect(`/rooms/${roomId}`);
});

// edit room
app.get('/rooms/:id/edit', async (req, res) => {
  const id = Number(req.params.id);
  const room = (await q(`SELECT * FROM rooms WHERE id=$1`, [id])).rows[0];
  if (!room) return res.status(404).send('Not found');
  const tariff = (await q(`SELECT * FROM tariffs WHERE room_id=$1`, [id])).rows[0];
  res.render('room_edit', { room, tariff });
});
app.put('/rooms/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { name, note, rent, internet_fee, cleaning_fee, electricity_price, water_price } = req.body;
  await q(`UPDATE rooms SET name=$1, note=$2 WHERE id=$3`, [name, note || null, id]);
  await q(`UPDATE tariffs SET rent=$1, internet_fee=$2, cleaning_fee=$3, electricity_price=$4, water_price=$5 WHERE room_id=$6`,
          [Number(rent), Number(internet_fee), Number(cleaning_fee), Number(electricity_price), Number(water_price), id]);
  // Tự tính lại hóa đơn nếu đang xem tháng cụ thể
  const yyyymm = req.query.yyyymm;
  if (yyyymm) {
    await recalcInvoice(id, yyyymm);
  }
  res.redirect(`/rooms/${id}`);
});

// room detail with month selection
app.get('/rooms/:id', async (req, res) => {
  const id = Number(req.params.id);
  const room = (await q(`SELECT * FROM rooms WHERE id=$1`, [id])).rows[0];
  if (!room) return res.status(404).send('Not found');

  const tenant = await activeTenant(id);
  const tariff  = await roomTariff(id);
  const yyyymm = (req.query.yyyymm && /^[0-9]{6}$/.test(req.query.yyyymm)) ? req.query.yyyymm : dayjs().format('YYYYMM');
  const meter = (await q(`SELECT * FROM meter_readings WHERE room_id=$1 AND yyyymm=$2`, [id, yyyymm])).rows[0] || null;

  let prefill = null, prevYyyymm = null;
  if (!meter) {
    prevYyyymm = prevMonthStr(yyyymm);
    const prev = (await q(`SELECT * FROM meter_readings WHERE room_id=$1 AND yyyymm=$2`, [id, prevYyyymm])).rows[0] || null;
    if (prev) prefill = { elec_start: prev.elec_end, water_start: prev.water_end };
  }

  const invoices = (await q(`SELECT * FROM invoices WHERE room_id=$1 ORDER BY yyyymm DESC`, [id])).rows;
  const hasCompleteMeter = !!(meter && Number(meter.elec_end) >= Number(meter.elec_start) && Number(meter.water_end) >= Number(meter.water_start));

  res.render('room', { room, tenant, tariff, yyyymm, meter, invoices, prefill, prevYyyymm, hasCompleteMeter });
});

// tenant manage
app.post('/rooms/:id/tenant', async (req, res) => {
  const id = Number(req.params.id);
  const { full_name, phone, started_at } = req.body;
  const current = await activeTenant(id);
  if (current) await q(`UPDATE tenants SET ended_at=$1 WHERE id=$2`, [dayjs().format('YYYY-MM-DD'), current.id]);
  await q(`INSERT INTO tenants (room_id, full_name, phone, started_at, ended_at)
           VALUES ($1,$2,$3,$4,NULL)`, [id, full_name.trim(), phone || null, started_at || dayjs().format('YYYY-MM-DD')]);
  res.redirect(`/rooms/${id}`);
});
app.post('/rooms/:id/tenant/end', async (req, res) => {
  const id = Number(req.params.id);
  const current = await activeTenant(id);
  if (current) await q(`UPDATE tenants SET ended_at=$1 WHERE id=$2`, [dayjs().format('YYYY-MM-DD'), current.id]);
  res.redirect(`/rooms/${id}`);
});

// meter save
app.post('/rooms/:id/meter', async (req, res) => {
  const id = Number(req.params.id);
  let { yyyymm, elec_start, elec_end, water_start, water_end } = req.body;

  function prevMonthStrLocal(yyyymm) {
    const y = Number(yyyymm.slice(0,4));
    const m = Number(yyyymm.slice(4,6));
    const d = dayjs(`${y}-${m}-01`).subtract(1,'month');
    return d.format('YYYYMM');
  }
  if (elec_start === '' || water_start === '') {
    const prev = (await q(`SELECT * FROM meter_readings WHERE room_id=$1 AND yyyymm=$2`, [id, prevMonthStrLocal(yyyymm)])).rows[0] || null;
    if (prev) {
      if (elec_start === '') elec_start = prev.elec_end;
      if (water_start === '') water_start = prev.water_end;
    }
  }

  if (Number(elec_end) < Number(elec_start) || Number(water_end) < Number(water_start)) {
    return res.status(400).send('Chỉ số cuối phải >= chỉ số đầu');
  }

  await q(`
    INSERT INTO meter_readings (room_id, yyyymm, elec_start, elec_end, water_start, water_end)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (room_id, yyyymm) DO UPDATE SET
      elec_start = EXCLUDED.elec_start,
      elec_end   = EXCLUDED.elec_end,
      water_start= EXCLUDED.water_start,
      water_end  = EXCLUDED.water_end
  `, [id, yyyymm, Number(elec_start), Number(elec_end), Number(water_start), Number(water_end)]);
  
  await recalcInvoice(id, yyyymm);
  res.redirect(`/rooms/${id}?yyyymm=${yyyymm}`);
});

// invoice
app.get('/rooms/:id/invoice/:yyyymm', async (req, res) => {
  const id = Number(req.params.id);
  const { yyyymm } = req.params;

  const room   = (await q(`SELECT * FROM rooms WHERE id=$1`, [id])).rows[0];
  const tenant = (await activeTenant(id));
  if (!room) return res.status(404).send('Không tìm thấy phòng');

  // Tự tính (và upsert) hóa đơn mỗi lần mở
  const recalc = await recalcInvoice(id, yyyymm);
  if (!recalc) return res.status(400).send('Thiếu chỉ số/thông tin đơn giá tháng này');
  const { invoice, elec_usage, water_usage, tariff } = recalc;

  res.render('invoice', {
    room, tenant, yyyymm,
    elec_usage, water_usage,
    subtotal_electricity: invoice.subtotal_electricity,
    subtotal_water: invoice.subtotal_water,
    rent: invoice.rent, internet_fee: invoice.internet_fee, cleaning_fee: invoice.cleaning_fee,
    total: invoice.total, createdAt: invoice.created_at,
    tariff,
    fmt: (n)=> new Intl.NumberFormat('vi-VN').format(n) + ' đ',
    fmtRaw: (n)=> new Intl.NumberFormat('vi-VN').format(n) + ' đ'
  });
});

const PORT = process.env.PORT || 3000;

// Chạy migrate trước khi mở cổng
(async () => {
  try {
    await migrate();
    app.listen(PORT, () => console.log('Running on port ' + PORT));
  } catch (e) {
    console.error('Migrate failed:', e);
    process.exit(1);
  }
})();
