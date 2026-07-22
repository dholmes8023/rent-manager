
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

// Tự bọc các async route handler để promise bị reject được chuyển tới
// error middleware thay vì gây unhandled rejection / treo request.
for (const method of ['get', 'post', 'put', 'delete']) {
  const original = app[method].bind(app);
  app[method] = (routePath, ...handlers) =>
    original(routePath, ...handlers.map(handler =>
      (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
    ));
}

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
// Chuyển sang số không âm; trả null nếu không hợp lệ
function toNonNegNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
// Validate các trường giá của phòng; trả { values } hoặc { error }
function parseTariffFields(body) {
  const fields = ['rent', 'internet_fee', 'cleaning_fee', 'electricity_price', 'water_price'];
  const values = {};
  for (const f of fields) {
    const n = toNonNegNumber(body[f]);
    if (n === null) return { error: `Giá trị "${f}" không hợp lệ` };
    values[f] = n;
  }
  // Số tháng thu: số nguyên >= 1, mặc định 1
  let months = 1;
  if (body.months !== undefined && body.months !== '') {
    const m = Number(body.months);
    if (!Number.isInteger(m) || m < 1) return { error: 'Số tháng phải là số nguyên >= 1' };
    months = m;
  }
  values.months = months;
  return { values };
}

function prevMonthStr(yyyymm) {
  const y = Number(yyyymm.slice(0,4));
  const m = Number(yyyymm.slice(4,6));
  const date = dayjs(`${y}-${m}-01`).subtract(1,'month');
  return date.format('YYYYMM');
}

// Nhãn kỳ thu: 1 tháng -> "07/2026"; nhiều tháng -> "Tháng 7,8,9/2026"
// (gộp theo năm, hỗ trợ dải tháng vắt qua năm: "Tháng 11,12/2026 - 1/2027")
function billingPeriodLabel(yyyymm, months) {
  const m = Math.max(1, Number(months) || 1);
  const startY = Number(yyyymm.slice(0, 4));
  const startM = Number(yyyymm.slice(4, 6));
  if (m <= 1) return `${String(startM).padStart(2, '0')}/${startY}`;

  const groups = [];
  for (let i = 0; i < m; i++) {
    const d = dayjs(`${startY}-${String(startM).padStart(2, '0')}-01`).add(i, 'month');
    const year = d.year();
    const month = d.month() + 1;
    let g = groups.find(x => x.year === year);
    if (!g) { g = { year, months: [] }; groups.push(g); }
    g.months.push(month);
  }
  return 'Tháng ' + groups.map(g => `${g.months.join(',')}/${g.year}`).join(' - ');
}

async function recalcInvoice(roomId, yyyymm) {
  const [tariffRes, meterRes] = await Promise.all([
    q(`SELECT * FROM tariffs WHERE room_id=$1`, [roomId]),
    q(`SELECT * FROM meter_readings WHERE room_id=$1 AND yyyymm=$2`, [roomId, yyyymm])
  ]);
  const tariff = tariffRes.rows[0];
  const meter  = meterRes.rows[0];
  if (!tariff || !meter) return null; // chưa đủ dữ liệu

  const elec_usage = Number((meter.elec_end - meter.elec_start).toFixed(2));
  const water_usage = Number((meter.water_end - meter.water_start).toFixed(2));
  const subtotal_electricity = Math.round(elec_usage * tariff.electricity_price);
  const subtotal_water       = Math.round(water_usage * tariff.water_price);
  // Phí cố định (phòng + mạng + vệ sinh) nhân theo số tháng thu; điện/nước
  // giữ theo chỉ số thực tế của tháng.
  const months = Math.max(1, Number(tariff.months) || 1);
  const fixed_monthly = tariff.rent + tariff.internet_fee + tariff.cleaning_fee;
  const total = fixed_monthly * months + subtotal_electricity + subtotal_water;

  const { rows } = await q(`
    INSERT INTO invoices (room_id, yyyymm, subtotal_electricity, subtotal_water, rent, internet_fee, cleaning_fee, months, total)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (room_id, yyyymm) DO UPDATE SET
      subtotal_electricity = EXCLUDED.subtotal_electricity,
      subtotal_water       = EXCLUDED.subtotal_water,
      rent                 = EXCLUDED.rent,
      internet_fee         = EXCLUDED.internet_fee,
      cleaning_fee         = EXCLUDED.cleaning_fee,
      months               = EXCLUDED.months,
      total                = EXCLUDED.total
    RETURNING *;
  `, [roomId, yyyymm, subtotal_electricity, subtotal_water, tariff.rent, tariff.internet_fee, tariff.cleaning_fee, months, total]);

  return { invoice: rows[0], elec_usage, water_usage, tariff };
}

// routes
app.get('/', async (req, res) => {
  const { rows } = await q(`
    SELECT r.*, t.full_name AS tenant
    FROM rooms r
    LEFT JOIN LATERAL (
      SELECT full_name FROM tenants t
      WHERE t.room_id = r.id AND t.ended_at IS NULL
      ORDER BY started_at DESC LIMIT 1
    ) t ON true
    ORDER BY r.id
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
  const { name, note, tenant_full_name, tenant_phone, tenant_started_at } = req.body;
  if (!name || name.trim() === '') return res.status(400).send('Tên phòng là bắt buộc');
  const parsed = parseTariffFields(req.body);
  if (parsed.error) return res.status(400).send(parsed.error);
  const { rent, internet_fee, cleaning_fee, electricity_price, water_price, months } = parsed.values;
  const { rows } = await q(`INSERT INTO rooms (name, note) VALUES ($1,$2) RETURNING id`, [name.trim(), note || null]);
  const roomId = rows[0].id;
  await q(`INSERT INTO tariffs (room_id, rent, internet_fee, cleaning_fee, electricity_price, water_price, months)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
           [roomId, rent, internet_fee, cleaning_fee, electricity_price, water_price, months]);
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
  const { name, note } = req.body;
  if (!name || name.trim() === '') return res.status(400).send('Tên phòng là bắt buộc');
  const parsed = parseTariffFields(req.body);
  if (parsed.error) return res.status(400).send(parsed.error);
  const { rent, internet_fee, cleaning_fee, electricity_price, water_price, months } = parsed.values;
  await q(`UPDATE rooms SET name=$1, note=$2 WHERE id=$3`, [name.trim(), note || null, id]);
  await q(`UPDATE tariffs SET rent=$1, internet_fee=$2, cleaning_fee=$3, electricity_price=$4, water_price=$5, months=$6 WHERE room_id=$7`,
          [rent, internet_fee, cleaning_fee, electricity_price, water_price, months, id]);
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
  const yyyymm = (req.query.yyyymm && /^[0-9]{6}$/.test(req.query.yyyymm)) ? req.query.yyyymm : dayjs().format('YYYYMM');
  const prevYm = prevMonthStr(yyyymm);

  const [roomRes, tenantRes, tariffRes, meterRes, prevMeterRes, invoicesRes, allRoomsRes] = await Promise.all([
    q(`SELECT * FROM rooms WHERE id=$1`, [id]),
    q(`SELECT * FROM tenants WHERE room_id=$1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`, [id]),
    q(`SELECT * FROM tariffs WHERE room_id=$1`, [id]),
    q(`SELECT * FROM meter_readings WHERE room_id=$1 AND yyyymm=$2`, [id, yyyymm]),
    q(`SELECT * FROM meter_readings WHERE room_id=$1 AND yyyymm=$2`, [id, prevYm]),
    q(`SELECT * FROM invoices WHERE room_id=$1 ORDER BY yyyymm DESC`, [id]),
    q(`SELECT r.id, r.name, (t.id IS NOT NULL) AS occupied
       FROM rooms r
       LEFT JOIN LATERAL (
         SELECT id FROM tenants WHERE room_id = r.id AND ended_at IS NULL LIMIT 1
       ) t ON true
       ORDER BY r.id`)
  ]);

  const room = roomRes.rows[0];
  if (!room) return res.status(404).send('Not found');

  const tenant = tenantRes.rows[0] || null;
  const tariff = tariffRes.rows[0] || null;
  const meter = meterRes.rows[0] || null;
  const invoices = invoicesRes.rows;

  let prefill = null, prevYyyymm = null;
  if (!meter) {
    const prev = prevMeterRes.rows[0] || null;
    if (prev) {
      prevYyyymm = prevYm;
      prefill = { elec_start: prev.elec_end, water_start: prev.water_end };
    }
  }

  const hasCompleteMeter = !!(meter && Number(meter.elec_end) >= Number(meter.elec_start) && Number(meter.water_end) >= Number(meter.water_start));

  res.render('room', { room, tenant, tariff, yyyymm, meter, invoices, prefill, prevYyyymm, hasCompleteMeter, allRooms: allRoomsRes.rows });
});

// tenant manage
app.post('/rooms/:id/tenant', async (req, res) => {
  const id = Number(req.params.id);
  const { full_name, phone, started_at } = req.body;
  if (!full_name || full_name.trim() === '') return res.status(400).send('Họ tên người thuê là bắt buộc');
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

  if (!/^[0-9]{6}$/.test(yyyymm || '')) {
    return res.status(400).send('Tháng (yyyymm) không hợp lệ');
  }
  const nums = [elec_start, elec_end, water_start, water_end].map(Number);
  if (nums.some(n => !Number.isFinite(n) || n < 0)) {
    return res.status(400).send('Chỉ số điện/nước không hợp lệ');
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
// invoice
app.get('/rooms/:id/invoice/:yyyymm', async (req, res) => {
  const id = Number(req.params.id);
  const { yyyymm } = req.params;

  const [roomRes, tenantRes, meterRes, settingsRes] = await Promise.all([
    q(`SELECT * FROM rooms WHERE id=$1`, [id]),
    q(`SELECT * FROM tenants WHERE room_id=$1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`, [id]),
    q(`SELECT * FROM meter_readings WHERE room_id=$1 AND yyyymm=$2`, [id, yyyymm]),
    q(`SELECT * FROM landlord_settings WHERE id=1`)
  ]);

  const room = roomRes.rows[0];
  const tenant = tenantRes.rows[0] || null;
  const meter = meterRes.rows[0] || null;
  const settings = settingsRes.rows[0] || {};
  
  if (!room) return res.status(404).send('Không tìm thấy phòng');

  // Tự tính (và upsert) hóa đơn mỗi lần mở
  const recalc = await recalcInvoice(id, yyyymm);
  if (!recalc) return res.status(400).send('Thiếu chỉ số/thông tin đơn giá tháng này');
  const { invoice, elec_usage, water_usage, tariff } = recalc;

  res.render('invoice', {
    room, tenant, yyyymm,
    meter, // ✅ thêm vào để EJS hiển thị chỉ số đầu/cuối
    elec_usage, water_usage,
    subtotal_electricity: invoice.subtotal_electricity,
    subtotal_water: invoice.subtotal_water,
    rent: invoice.rent, internet_fee: invoice.internet_fee, cleaning_fee: invoice.cleaning_fee,
    months: invoice.months, periodLabel: billingPeriodLabel(yyyymm, invoice.months),
    total: invoice.total, createdAt: invoice.created_at,
    tariff, settings,
    fmt: (n)=> new Intl.NumberFormat('vi-VN').format(n) + ' đ',
    fmtRaw: (n)=> new Intl.NumberFormat('vi-VN').format(n) + ' đ'
  });
});

// export all invoices to zip client side
app.get('/export/:yyyymm', async (req, res) => {
  const { yyyymm } = req.params;
  const { rows } = await q(`
    SELECT r.id as room_id, r.name as room_name,
           i.subtotal_electricity, i.subtotal_water, i.rent, i.internet_fee, i.cleaning_fee, i.months, i.total, i.created_at,
           m.elec_start, m.elec_end, m.water_start, m.water_end,
           t.full_name as tenant_name,
           tf.electricity_price, tf.water_price
    FROM invoices i
    JOIN rooms r ON i.room_id = r.id
    JOIN meter_readings m ON m.room_id = r.id AND m.yyyymm = i.yyyymm
    JOIN tariffs tf ON tf.room_id = r.id
    LEFT JOIN LATERAL (
      SELECT full_name FROM tenants 
      WHERE room_id = r.id AND started_at <= i.created_at AND (ended_at IS NULL OR ended_at >= i.created_at)
      ORDER BY started_at DESC LIMIT 1
    ) t ON true
    WHERE i.yyyymm = $1
    ORDER BY r.id
  `, [yyyymm]);

  const settingsRes = await q(`SELECT * FROM landlord_settings WHERE id=1`);
  const settings = settingsRes.rows[0] || {};
  
  res.render('export', {
    yyyymm,
    invoices: rows.map(r => ({ ...r, periodLabel: billingPeriodLabel(yyyymm, r.months) })),
    settings,
    fmt: (n)=> new Intl.NumberFormat('vi-VN').format(n) + ' đ',
    fmtRaw: (n)=> new Intl.NumberFormat('vi-VN').format(n) + ' đ'
  });
});

// bulk meter routes
app.get('/meters', async (req, res) => {
  const yyyymm = (req.query.yyyymm && /^[0-9]{6}$/.test(req.query.yyyymm)) ? req.query.yyyymm : dayjs().format('YYYYMM');
  const prevYm = prevMonthStr(yyyymm);

  const [roomsRes, meterRes, prevMeterRes, tenantsRes] = await Promise.all([
    q(`SELECT * FROM rooms ORDER BY id`),
    q(`SELECT * FROM meter_readings WHERE yyyymm=$1`, [yyyymm]),
    q(`SELECT * FROM meter_readings WHERE yyyymm=$1`, [prevYm]),
    q(`SELECT room_id FROM tenants WHERE ended_at IS NULL`)
  ]);

  const metersByRoom = {};
  meterRes.rows.forEach(m => metersByRoom[m.room_id] = m);
  const prevMetersByRoom = {};
  prevMeterRes.rows.forEach(m => prevMetersByRoom[m.room_id] = m);
  
  const occupiedRooms = new Set(tenantsRes.rows.map(t => t.room_id));

  res.render('bulk_meter', { 
    yyyymm, 
    rooms: roomsRes.rows, 
    metersByRoom, 
    prevMetersByRoom,
    occupiedRooms
  });
});

app.post('/meters', async (req, res) => {
  const { yyyymm } = req.body;
  const updates = [];
  
  for (const key of Object.keys(req.body)) {
    if (key.startsWith('elec_end_')) {
      const roomId = Number(key.replace('elec_end_', ''));
      const elec_end = req.body[`elec_end_${roomId}`];
      const water_end = req.body[`water_end_${roomId}`];
      const elec_start = req.body[`elec_start_${roomId}`];
      const water_start = req.body[`water_start_${roomId}`];
      
      if (elec_start !== '' && elec_end !== '' && water_start !== '' && water_end !== '') {
        updates.push({
          roomId,
          elec_start: Number(elec_start),
          elec_end: Number(elec_end),
          water_start: Number(water_start),
          water_end: Number(water_end)
        });
      }
    }
  }

  await Promise.all(updates.map(async u => {
    if (u.elec_end >= u.elec_start && u.water_end >= u.water_start) {
      await q(`
        INSERT INTO meter_readings (room_id, yyyymm, elec_start, elec_end, water_start, water_end)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (room_id, yyyymm) DO UPDATE SET
          elec_start = EXCLUDED.elec_start,
          elec_end   = EXCLUDED.elec_end,
          water_start= EXCLUDED.water_start,
          water_end  = EXCLUDED.water_end
      `, [u.roomId, yyyymm, u.elec_start, u.elec_end, u.water_start, u.water_end]);
      await recalcInvoice(u.roomId, yyyymm);
    }
  }));
  
  res.redirect(`/meters?yyyymm=${yyyymm}`);
});

// Error middleware — đặt sau tất cả routes
app.use((err, req, res, next) => {
  console.error('Request error:', err);
  if (res.headersSent) return next(err);
  res.status(500).send('Đã xảy ra lỗi máy chủ. Vui lòng thử lại.');
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
