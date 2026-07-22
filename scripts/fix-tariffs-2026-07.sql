-- ============================================================
--  Cập nhật đơn giá & phí phòng theo hóa đơn tháng 7/2026
--  Chạy MỘT LẦN trên database (Neon/Render).
--
--  Giá trị dưới đây là GỐC THEO THÁNG. Hệ thống nhân với `months`
--  khi tính hóa đơn, nên với ki-ốt thu 3 tháng, tiền phòng/mạng/vệ
--  sinh đã được chia 3 (VD Kiot 01: 18.000.000 / 3 = 6.000.000).
--
--  Lưu ý:
--   - P403 KHÔNG có trong ảnh nên KHÔNG bị thay đổi.
--   - Nếu tên phòng trong DB khác (VD "Kiot-01"), dòng đó update 0
--     bản ghi (vô hại) — kiểm tra bằng SELECT ở cuối rồi sửa tên nếu cần.
--   - Bọc trong transaction: xem kết quả SELECT trước khi COMMIT.
-- ============================================================

BEGIN;

-- 1) Cập nhật bảng đơn giá/phí (nguồn dữ liệu cho mọi lần tính sau này)
WITH data(name, rent, internet_fee, cleaning_fee, electricity_price, water_price, months) AS (
  VALUES
    -- name,      rent,     internet, cleaning, elec, water, months
    ('P201',    3500000,        0,   20000, 4500, 35000, 1),
    ('P202',    3000000,   100000,   20000, 4500, 35000, 1),
    ('P203',    3000000,   100000,   20000, 3500, 35000, 1),  -- giá điện 3.500
    ('P204',    3200000,   100000,   60000, 4500, 35000, 1),
    ('P301',    3500000,   100000,   60000, 4500, 35000, 1),
    ('P302',    3200000,        0,   40000, 4500, 35000, 1),
    ('P303',    3200000,   100000,   40000, 4500, 35000, 1),
    ('P304',    3200000,   100000,   20000, 4500, 35000, 1),
    ('P401',    3200000,   100000,   60000, 4500, 35000, 1),
    ('P402',    3200000,   100000,   40000, 4500, 35000, 1),
    ('P404',    3200000,   100000,   60000, 4500, 35000, 1),
    -- Ki-ốt thu 3 tháng: tiền phòng/mạng/vệ sinh = giá trị trên ảnh chia 3
    ('Kiot 01', 6000000,   100000,   20000, 4500, 35000, 3),  -- ảnh: 18.000.000 / 300.000 / 60.000
    ('Kiot 02', 6000000,   100000,   20000, 4500, 35000, 3),  -- ảnh: 18.000.000 / 300.000 / 60.000
    ('Kiot 03', 5500000,   100000,   40000, 4500, 35000, 1),  -- thu 1 tháng
    ('Kiot 04', 6000000,   100000,   40000, 4500, 35000, 3)   -- ảnh: 18.000.000 / 300.000 / 120.000
)
UPDATE tariffs t
SET rent              = d.rent,
    internet_fee      = d.internet_fee,
    cleaning_fee      = d.cleaning_fee,
    electricity_price = d.electricity_price,
    water_price       = d.water_price,
    months            = d.months
FROM data d
JOIN rooms r ON r.name = d.name
WHERE t.room_id = r.id;

-- 2) Tính lại các hóa đơn ĐÃ CÓ theo đơn giá mới + chỉ số hiện tại
--    (để bản xuất ZIP / lịch sử khớp ngay, không cần mở lại từng phòng).
--    Công thức giống app: (phòng+mạng+vệ sinh) × số tháng + điện + nước.
UPDATE invoices i
SET subtotal_electricity = ROUND((m.elec_end  - m.elec_start)  * t.electricity_price)::int,
    subtotal_water       = ROUND((m.water_end - m.water_start) * t.water_price)::int,
    rent                 = t.rent,
    internet_fee         = t.internet_fee,
    cleaning_fee         = t.cleaning_fee,
    months               = t.months,
    total                = (t.rent + t.internet_fee + t.cleaning_fee) * t.months
                           + ROUND((m.elec_end  - m.elec_start)  * t.electricity_price)::int
                           + ROUND((m.water_end - m.water_start) * t.water_price)::int
FROM tariffs t, meter_readings m
WHERE i.room_id = t.room_id
  AND m.room_id = i.room_id
  AND m.yyyymm  = i.yyyymm;

-- 3) Kiểm tra kết quả trước khi COMMIT
SELECT r.name,
       t.rent, t.internet_fee AS internet, t.cleaning_fee AS vesinh,
       t.electricity_price AS gia_dien, t.water_price AS gia_nuoc, t.months
FROM tariffs t
JOIN rooms r ON r.id = t.room_id
ORDER BY r.name;

COMMIT;
