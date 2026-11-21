/* global process, console */
// Chạy trước `pnpm dev` / `pnpm openapi:export`: nếu chưa có .env thì tạo từ .env.example
// để service chạy được ngay. Không ghi đè .env đã có.
import { copyFileSync, existsSync } from 'node:fs';

if (!existsSync('.env')) {
  if (!existsSync('.env.example')) {
    console.error('Thiếu cả .env lẫn .env.example trong thư mục service.');
    process.exit(1);
  }
  copyFileSync('.env.example', '.env');
  console.log('Đã tạo .env từ .env.example (sửa SERVICE_NAME/PORT cho service của bạn).');
}
