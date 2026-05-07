import { q } from '../../db.js';

export async function getLandlordSettings() {
  const { rows } = await q(`SELECT * FROM landlord_settings WHERE id = 1`);
  return rows[0] || {};
}

export async function upsertLandlordSettings({
  owner_name,
  phone,
  address,
  bank_name,
  bank_account,
}) {
  await q(
    `INSERT INTO landlord_settings (id, owner_name, phone, address, bank_name, bank_account)
     VALUES (1, $1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       owner_name   = EXCLUDED.owner_name,
       phone        = EXCLUDED.phone,
       address      = EXCLUDED.address,
       bank_name    = EXCLUDED.bank_name,
       bank_account = EXCLUDED.bank_account`,
    [owner_name, phone, address, bank_name, bank_account]
  );
}
