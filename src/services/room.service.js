import { q } from '../../db.js';

export async function listRoomsWithTenant() {
  const { rows } = await q(
    `SELECT r.*,
            (SELECT full_name FROM tenants t
              WHERE t.room_id = r.id AND t.ended_at IS NULL
              ORDER BY started_at DESC LIMIT 1) AS tenant
       FROM rooms r
      ORDER BY r.id`
  );
  return rows;
}

export async function getRoomById(id) {
  const { rows } = await q(`SELECT * FROM rooms WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function createRoomWithTariff({ name, note, tariff }) {
  const { rows } = await q(`INSERT INTO rooms (name, note) VALUES ($1, $2) RETURNING id`, [
    name,
    note || null,
  ]);
  const roomId = rows[0].id;
  await q(
    `INSERT INTO tariffs (room_id, rent, internet_fee, cleaning_fee, electricity_price, water_price)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      roomId,
      Number(tariff.rent),
      Number(tariff.internet_fee),
      Number(tariff.cleaning_fee),
      Number(tariff.electricity_price),
      Number(tariff.water_price),
    ]
  );
  return roomId;
}

export async function updateRoomWithTariff(id, { name, note, tariff }) {
  await q(`UPDATE rooms SET name = $1, note = $2 WHERE id = $3`, [name, note || null, id]);
  await q(
    `UPDATE tariffs SET rent = $1, internet_fee = $2, cleaning_fee = $3,
                       electricity_price = $4, water_price = $5
       WHERE room_id = $6`,
    [
      Number(tariff.rent),
      Number(tariff.internet_fee),
      Number(tariff.cleaning_fee),
      Number(tariff.electricity_price),
      Number(tariff.water_price),
      id,
    ]
  );
}
