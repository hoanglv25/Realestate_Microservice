import { ValueTransformer } from 'typeorm';

/**
 * Tiền VND lưu bằng cột `bigint` (số nguyên, KHÔNG dùng float/decimal).
 * Driver pg trả bigint dưới dạng chuỗi nên cần chuyển về number khi đọc.
 * Số nguyên an toàn tối đa 2^53 (~9.007e15 đồng) là dư cho mọi giao dịch thuê nhà.
 */
export const bigintToNumber: ValueTransformer = {
  to: (value?: number | null) => value,
  from: (value?: string | null) => (value === null || value === undefined ? value : Number(value)),
};
