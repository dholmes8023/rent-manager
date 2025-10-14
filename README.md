
# Rent Manager v4.3 (Postgres)
**Nhúng sẵn cấu hình theo yêu cầu:**
- Đơn giá điện: 4.500 đ/kWh, nước: 35.000 đ/m³ (áp cho toàn bộ phòng)
- Seed 12 phòng: P201..P404, mỗi phòng có rent / vệ sinh (vs) / mạng đúng như mô tả
- Giữ tính năng v4.2: chọn tháng, chỉ hiện nút hóa đơn khi đủ chỉ số, tự prefill đầu từ tháng trước

## Chạy local
```
npm install
cp .env.example .env   # sửa DATABASE_URL
npm start
```
