import { q } from '../../db.js';

export async function activeTenant(roomId) {
  const { rows } = await q(
    `SELECT * FROM tenants
     WHERE room_id = $1 AND ended_at IS NULL
     ORDER BY started_at DESC LIMIT 1`,
    [roomId]
  );
  return rows[0] || null;
}

export async function endActiveTenant(roomId, endedAt) {
  const current = await activeTenant(roomId);
  if (!current) return null;
  await q(`UPDATE tenants SET ended_at = $1 WHERE id = $2`, [endedAt, current.id]);
  return current;
}

export async function startTenant(roomId, { fullName, phone, startedAt }) {
  const { rows } = await q(
    `INSERT INTO tenants (room_id, full_name, phone, started_at, ended_at)
     VALUES ($1, $2, $3, $4, NULL)
     RETURNING *`,
    [roomId, fullName.trim(), phone || null, startedAt]
  );
  return rows[0];
}
