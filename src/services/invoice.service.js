import { q } from '../../db.js';

export async function getRoomTariff(roomId) {
  const { rows } = await q(`SELECT * FROM tariffs WHERE room_id = $1`, [roomId]);
  return rows[0] || null;
}

export async function getMeterReading(roomId, yyyymm) {
  const { rows } = await q(`SELECT * FROM meter_readings WHERE room_id = $1 AND yyyymm = $2`, [
    roomId,
    yyyymm,
  ]);
  return rows[0] || null;
}

export async function upsertMeterReading(roomId, yyyymm, values) {
  const { elec_start, elec_end, water_start, water_end } = values;
  await q(
    `INSERT INTO meter_readings (room_id, yyyymm, elec_start, elec_end, water_start, water_end)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (room_id, yyyymm) DO UPDATE SET
       elec_start = EXCLUDED.elec_start,
       elec_end   = EXCLUDED.elec_end,
       water_start= EXCLUDED.water_start,
       water_end  = EXCLUDED.water_end`,
    [roomId, yyyymm, Number(elec_start), Number(elec_end), Number(water_start), Number(water_end)]
  );
}

/**
 * Recompute and upsert the invoice for a given room/month.
 * Returns null when prerequisite tariff or meter data is missing.
 */
export async function recalcInvoice(roomId, yyyymm) {
  const tariff = await getRoomTariff(roomId);
  const meter = await getMeterReading(roomId, yyyymm);
  if (!tariff || !meter) return null;

  const elec_usage = Number((meter.elec_end - meter.elec_start).toFixed(2));
  const water_usage = Number((meter.water_end - meter.water_start).toFixed(2));
  const subtotal_electricity = Math.round(elec_usage * tariff.electricity_price);
  const subtotal_water = Math.round(water_usage * tariff.water_price);
  const total =
    tariff.rent + tariff.internet_fee + tariff.cleaning_fee + subtotal_electricity + subtotal_water;

  const { rows } = await q(
    `INSERT INTO invoices (room_id, yyyymm, subtotal_electricity, subtotal_water,
                           rent, internet_fee, cleaning_fee, total)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (room_id, yyyymm) DO UPDATE SET
       subtotal_electricity = EXCLUDED.subtotal_electricity,
       subtotal_water       = EXCLUDED.subtotal_water,
       rent                 = EXCLUDED.rent,
       internet_fee         = EXCLUDED.internet_fee,
       cleaning_fee         = EXCLUDED.cleaning_fee,
       total                = EXCLUDED.total,
       created_at           = NOW()
     RETURNING *`,
    [
      roomId,
      yyyymm,
      subtotal_electricity,
      subtotal_water,
      tariff.rent,
      tariff.internet_fee,
      tariff.cleaning_fee,
      total,
    ]
  );

  return { invoice: rows[0], elec_usage, water_usage, tariff };
}

export async function listInvoices(roomId) {
  const { rows } = await q(`SELECT * FROM invoices WHERE room_id = $1 ORDER BY yyyymm DESC`, [
    roomId,
  ]);
  return rows;
}
