
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false
});

export async function q(text, params) {
  return pool.query(text, params);
}

export async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      note TEXT
    );
    CREATE TABLE IF NOT EXISTS tenants (
      id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL,
      phone TEXT,
      started_at DATE,
      ended_at DATE
    );
    CREATE TABLE IF NOT EXISTS tariffs (
      id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL UNIQUE REFERENCES rooms(id) ON DELETE CASCADE,
      rent INTEGER NOT NULL,
      internet_fee INTEGER NOT NULL DEFAULT 0,
      cleaning_fee INTEGER NOT NULL DEFAULT 0,
      electricity_price INTEGER NOT NULL,
      water_price INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meter_readings (
      id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      yyyymm VARCHAR(6) NOT NULL,
      elec_start DOUBLE PRECISION NOT NULL,
      elec_end DOUBLE PRECISION NOT NULL,
      water_start DOUBLE PRECISION NOT NULL,
      water_end DOUBLE PRECISION NOT NULL,
      UNIQUE(room_id, yyyymm)
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      yyyymm VARCHAR(6) NOT NULL,
      subtotal_electricity INTEGER NOT NULL,
      subtotal_water INTEGER NOT NULL,
      rent INTEGER NOT NULL,
      internet_fee INTEGER NOT NULL,
      cleaning_fee INTEGER NOT NULL,
      total INTEGER NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(room_id, yyyymm)
    );
    CREATE TABLE IF NOT EXISTS landlord_settings (
      id INTEGER PRIMARY KEY,
      owner_name TEXT,
      phone TEXT,
      address TEXT,
      bank_name TEXT,
      bank_account TEXT
    );
  `);

  await q(`INSERT INTO landlord_settings (id, owner_name, phone, address, bank_name, bank_account)
           VALUES (1, 'Chủ trọ', '', '', '', '') ON CONFLICT (id) DO NOTHING;`);

  // --- Embedded seed for unit prices and rooms P201..P404 ---
  const UNIT_ELEC = 4500;
  const UNIT_WATER = 35000;

  // Force update unit prices for all existing tariffs to new units
  await q('UPDATE tariffs SET electricity_price = $1, water_price = $2', [UNIT_ELEC, UNIT_WATER]);

  const rooms = [
    ['P201', 3500000, 20000, 100000, '1 người'],
    ['P202', 3200000, 60000, 100000, '3 người'],
    ['P203', 3200000, 20000, 100000, '1 người'],
    ['P204', 3200000, 60000, 100000, '3 người'],
    ['P301', 3500000, 60000, 100000, '3 người'],
    ['P302', 3200000, 40000,      0, '2 người - không dùng mạng'],
    ['P303', 3200000, 40000, 100000, '2 người'],
    ['P304', 3200000, 20000, 100000, '1 người'],
    ['P401', 3200000, 60000, 100000, '3 người'],
    ['P402', 3200000, 40000, 100000, '2 người'],
    ['P403', 3200000, 40000, 100000, '2 người'],
    ['P404', 3200000, 60000, 100000, '3 người']
  ];

  for (const [name, rent, cleaning, internet, note] of rooms) {
    // Upsert room
    await q(`INSERT INTO rooms (name, note)
             VALUES ($1,$2)
             ON CONFLICT (name) DO UPDATE SET note = EXCLUDED.note`, [name, note]);
    const { rows } = await q(`SELECT id FROM rooms WHERE name = $1`, [name]);
    const id = rows[0].id;
    // Upsert tariff for room
    await q(`INSERT INTO tariffs (room_id, rent, internet_fee, cleaning_fee, electricity_price, water_price)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (room_id) DO UPDATE SET
               rent = EXCLUDED.rent,
               internet_fee = EXCLUDED.internet_fee,
               cleaning_fee = EXCLUDED.cleaning_fee,
               electricity_price = EXCLUDED.electricity_price,
               water_price = EXCLUDED.water_price`,
             [id, rent, internet, cleaning, UNIT_ELEC, UNIT_WATER]);
  }
}
