# Rent Manager

[![CI](https://github.com/dholmes8023/rent-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/dholmes8023/rent-manager/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Ứng dụng web nhỏ gọn để **quản lý phòng trọ**: theo dõi thông tin phòng, người thuê, ghi chỉ số điện/nước theo tháng và tự động sinh hoá đơn có thể in.

Stack: **Node.js (ESM) · Express · EJS · PostgreSQL · Tailwind (CDN) · dayjs**.

## Tính năng

- Danh sách phòng, trạng thái phòng (đã có người / phòng trống)
- Quản lý người thuê hiện tại (bắt đầu / kết thúc thuê)
- Cấu hình đơn giá điện/nước, tiền phòng, mạng, vệ sinh theo từng phòng
- Ghi chỉ số công tơ điện & nước theo từng tháng (`YYYYMM`)
  - Tự prefill chỉ số đầu từ tháng trước
  - Validate chỉ số cuối ≥ chỉ số đầu
- Tự động tính & lưu hoá đơn theo tháng, có trang **in hoá đơn** thân thiện với máy in
- Trang **Thông tin chủ trọ** (tên, SĐT, địa chỉ, ngân hàng, số tài khoản)
- Endpoint `/healthz` để monitoring và Docker `HEALTHCHECK`
- Bảo mật cơ bản: `helmet`, gzip (`compression`), request log (`morgan`), error handler tập trung

## Yêu cầu hệ thống

- Node.js **>= 20** (xem [`.nvmrc`](.nvmrc))
- PostgreSQL **>= 13** (local hoặc managed: Render, Railway, Supabase, Neon, …)
- npm 10+

## Cài đặt & chạy local

```bash
# 1. Cài dependencies
npm ci   # hoặc: npm install

# 2. Tạo file env
cp .env.example .env
# Sửa DATABASE_URL trỏ tới Postgres của bạn

# 3. Chạy app (tự động migrate + seed 12 phòng P201..P404 lần đầu)
npm start

# Mở http://localhost:3000
```

Chế độ phát triển có hot reload (Node 20+):

```bash
npm run dev
```

### Biến môi trường

| Biến           | Bắt buộc | Mặc định      | Mô tả                                                                             |
| -------------- | :------: | ------------- | --------------------------------------------------------------------------------- |
| `DATABASE_URL` |    ✓     | _(không có)_  | Chuỗi kết nối Postgres. SSL bật khi URL chứa `render.com` hoặc `sslmode=require`. |
| `PORT`         |          | `3000`        | Cổng HTTP của server.                                                             |
| `NODE_ENV`     |          | `development` | `production` để bật log `combined` và ẩn stacktrace.                              |

## Chạy bằng Docker

```bash
# Build image
docker build -t rent-manager .

# Chạy container (cần Postgres đang chạy ở host hoặc URL bên ngoài)
docker run --rm -p 3000:3000 \
  -e DATABASE_URL="postgres://user:pass@host:5432/rent_manager" \
  rent-manager
```

Image đa giai đoạn dựa trên `node:20-alpine`, chạy bằng user `node` (không phải root) và có sẵn `HEALTHCHECK` gọi `/healthz`.

## Deploy

Ứng dụng là một Express server thuần Node, có thể deploy lên hầu hết các nền tảng:

- **Render / Railway / Fly.io**: trỏ build command vào `npm ci` và start command `npm start`. Đặt `DATABASE_URL` bằng connection string của Postgres managed.
- **Docker host (VPS, ECS, Cloud Run)**: dùng `Dockerfile` đi kèm; expose cổng `3000` và đặt `DATABASE_URL`.

Migration & seed dữ liệu phòng được chạy tự động khi server khởi động (xem [`db.js`](db.js)).

## Cấu trúc thư mục

```
.
├── app.js                        # Entry point, lắp ráp Express app
├── db.js                         # Kết nối Postgres + migrate + seed
├── public/                       # Static assets
├── views/                        # EJS templates (index, room, invoice, settings, …)
├── src/
│   ├── config/env.js             # Load .env, validate biến môi trường
│   ├── middleware/               # asyncHandler, error handler
│   ├── routes/                   # Express routers (rooms, invoice, settings, health)
│   ├── services/                 # Truy cập DB cho từng domain
│   └── utils/                    # Helpers (date, format)
├── Dockerfile
├── eslint.config.js
└── .github/workflows/ci.yml
```

## Scripts

| Script                 | Mô tả                                 |
| ---------------------- | ------------------------------------- |
| `npm start`            | Chạy production server.               |
| `npm run dev`          | Chạy với `node --watch` (hot reload). |
| `npm run lint`         | Chạy ESLint.                          |
| `npm run lint:fix`     | ESLint + tự fix.                      |
| `npm run format`       | Prettier ghi đè format.               |
| `npm run format:check` | Prettier kiểm tra format (CI dùng).   |

## Các route chính

| Method | Path                         | Mô tả                                   |
| ------ | ---------------------------- | --------------------------------------- |
| GET    | `/`                          | Danh sách phòng.                        |
| GET    | `/rooms/new`                 | Form thêm phòng.                        |
| POST   | `/rooms`                     | Tạo phòng + tariff (+ tenant tuỳ chọn). |
| GET    | `/rooms/:id`                 | Chi tiết phòng theo tháng.              |
| GET    | `/rooms/:id/edit`            | Form sửa phòng/tariff.                  |
| PUT    | `/rooms/:id`                 | Cập nhật phòng/tariff.                  |
| POST   | `/rooms/:id/tenant`          | Bắt đầu / đổi người thuê.               |
| POST   | `/rooms/:id/tenant/end`      | Kết thúc người thuê hiện tại.           |
| POST   | `/rooms/:id/meter`           | Lưu chỉ số tháng + recompute hoá đơn.   |
| GET    | `/rooms/:id/invoice/:yyyymm` | Trang hoá đơn (in được).                |
| GET    | `/settings`                  | Thông tin chủ trọ.                      |
| POST   | `/settings`                  | Lưu thông tin chủ trọ.                  |
| GET    | `/healthz`                   | Healthcheck (kèm ping DB).              |

## Đóng góp

Pull request được hoan nghênh! Trước khi gửi PR, vui lòng:

```bash
npm run lint
npm run format:check
```

CI sẽ chạy lại các kiểm tra trên cho mọi PR vào `main`.

## License

[MIT](LICENSE) © 2025 dholmes8023
