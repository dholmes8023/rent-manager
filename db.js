
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const { Pool } = pg;

// Đơn giá vệ sinh tính theo đầu người (đồng/người/tháng).
// Tiền vệ sinh mỗi phòng = số người × hằng số này.
export const CLEANING_PER_PERSON = 20000;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && (process.env.DATABASE_URL.includes('render.com') || process.env.DATABASE_URL.includes('neon.tech'))
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
    CREATE INDEX IF NOT EXISTS idx_tenants_room_id ON tenants(room_id);
    CREATE INDEX IF NOT EXISTS idx_tenants_ended_at ON tenants(ended_at);
    CREATE INDEX IF NOT EXISTS idx_invoices_yyyymm ON invoices(yyyymm);
  `);

  // Số tháng thu tiền cho mỗi phòng (phí cố định nhân theo số tháng này).
  // Idempotent: an toàn khi chạy lại mỗi lần khởi động.
  await q(`ALTER TABLE tariffs  ADD COLUMN IF NOT EXISTS months INTEGER NOT NULL DEFAULT 1;`);
  await q(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS months INTEGER NOT NULL DEFAULT 1;`);

  // Số người ở/phòng — dùng để tính phí vệ sinh (số người × CLEANING_PER_PERSON).
  // Backfill chỉ chạy đúng một lần khi cột vừa được thêm: suy ngược số người từ
  // phí vệ sinh cũ (cleaning_fee / đơn giá) để không làm hỏng dữ liệu đang có.
  const tariffPeople = await q(`SELECT 1 FROM information_schema.columns
                                WHERE table_name='tariffs' AND column_name='people'`);
  if (tariffPeople.rowCount === 0) {
    await q(`ALTER TABLE tariffs ADD COLUMN people INTEGER NOT NULL DEFAULT 1;`);
    await q(`UPDATE tariffs SET people = GREATEST(1, ROUND(cleaning_fee::numeric / $1))`, [CLEANING_PER_PERSON]);
  }
  const invoicePeople = await q(`SELECT 1 FROM information_schema.columns
                                 WHERE table_name='invoices' AND column_name='people'`);
  if (invoicePeople.rowCount === 0) {
    await q(`ALTER TABLE invoices ADD COLUMN people INTEGER NOT NULL DEFAULT 1;`);
    await q(`UPDATE invoices SET people = GREATEST(1, ROUND(cleaning_fee::numeric / $1))`, [CLEANING_PER_PERSON]);
  }

  // Đơn giá vệ sinh/người có thể chỉnh trong màn Cài đặt (mặc định = hằng số trên).
  await q(`ALTER TABLE landlord_settings ADD COLUMN IF NOT EXISTS cleaning_per_person INTEGER NOT NULL DEFAULT ${CLEANING_PER_PERSON};`);

  await q(`INSERT INTO landlord_settings (id, owner_name, phone, address, bank_name, bank_account)
           VALUES (1, 'Chủ trọ', '', '', '', '') ON CONFLICT (id) DO NOTHING;`);

  // --- Embedded seed for unit prices and rooms P201..P404 ---
  // Chỉ seed khi bảng rooms trống (lần chạy đầu). KHÔNG ghi đè dữ liệu
  // đã có, để các chỉnh sửa qua giao diện (tiền phòng, đơn giá...) không
  // bị revert sau mỗi lần khởi động server.
  const { rows: countRows } = await q(`SELECT COUNT(*)::int AS n FROM rooms`);
  if (countRows[0].n > 0) return;

  const UNIT_ELEC = 4500;
  const UNIT_WATER = 35000;

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
    // Upsert tariff for room (số người suy từ phí vệ sinh seed để nhất quán)
    const people = Math.max(1, Math.round(cleaning / CLEANING_PER_PERSON));
    await q(`INSERT INTO tariffs (room_id, rent, internet_fee, cleaning_fee, electricity_price, water_price, people)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (room_id) DO UPDATE SET
               rent = EXCLUDED.rent,
               internet_fee = EXCLUDED.internet_fee,
               cleaning_fee = EXCLUDED.cleaning_fee,
               electricity_price = EXCLUDED.electricity_price,
               water_price = EXCLUDED.water_price,
               people = EXCLUDED.people`,
             [id, rent, internet, cleaning, UNIT_ELEC, UNIT_WATER, people]);
  }
}
