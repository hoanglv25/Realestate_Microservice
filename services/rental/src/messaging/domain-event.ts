import { randomUUID } from 'node:crypto';

/**
 * Envelope chung của mọi domain event, khớp `contracts/events/envelope.v1.schema.json`.
 * Payload của từng event xem schema `contracts/events/<eventType>.v<version>.schema.json`.
 */
export interface DomainEvent<TPayload extends object = Record<string, unknown>> {
  /** UUID, consumer dùng để chống xử lý trùng. */
  eventId: string;
  /** Bằng routing key: `<miền>.<sự kiện>`, ví dụ `rental.deposit-created`. */
  eventType: string;
  /** Phiên bản schema của payload. */
  version: number;
  /** Thời điểm nghiệp vụ xảy ra, ISO 8601 UTC. */
  occurredAt: string;
  /** X-Request-ID của request gốc. */
  correlationId: string;
  /** Service phát event (SERVICE_NAME). */
  producer: string;
  payload: TPayload;
}

/** `<miền>.<sự kiện>`: miền chỉ chữ thường; sự kiện cho phép gạch ngang (A4, khớp envelope.v1.schema.json). */
export const EVENT_TYPE_PATTERN = /^[a-z]+\.[a-z-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORRELATION_ID = /^[\w.:-]{1,128}$/;

export interface BuildEventInput<TPayload extends object> {
  eventType: string;
  payload: TPayload;
  producer: string;
  version?: number;
  correlationId?: string;
  occurredAt?: Date;
}

/** Dựng envelope. Không có correlationId (ví dụ job chạy nền) thì dùng chính eventId. */
export function buildDomainEvent<TPayload extends object>(
  input: BuildEventInput<TPayload>,
): DomainEvent<TPayload> {
  if (!EVENT_TYPE_PATTERN.test(input.eventType)) {
    throw new Error(
      `eventType "${input.eventType}" phải có dạng <miền>.<sự kiện> (chữ thường, sự kiện được có gạch ngang)`,
    );
  }
  const eventId = randomUUID();
  return {
    eventId,
    eventType: input.eventType,
    version: input.version ?? 1,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    correlationId:
      input.correlationId && CORRELATION_ID.test(input.correlationId)
        ? input.correlationId
        : eventId,
    producer: input.producer,
    payload: input.payload,
  };
}

/**
 * Kiểm tra tối thiểu phần envelope của message nhận được (phía consumer KHÔNG validate chặt
 * payload, để producer thêm trường mới không làm hỏng consumer). Trả về lý do nếu sai.
 */
export function checkEnvelope(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'không phải JSON object';
  const e = value as Record<string, unknown>;
  if (typeof e.eventId !== 'string' || !UUID.test(e.eventId)) return 'eventId không phải UUID';
  if (typeof e.eventType !== 'string' || !EVENT_TYPE_PATTERN.test(e.eventType)) {
    return 'eventType sai định dạng';
  }
  if (!Number.isInteger(e.version) || (e.version as number) < 1) return 'version không hợp lệ';
  if (typeof e.occurredAt !== 'string' || Number.isNaN(Date.parse(e.occurredAt))) {
    return 'occurredAt không phải thời gian hợp lệ';
  }
  if (!e.payload || typeof e.payload !== 'object' || Array.isArray(e.payload)) {
    return 'payload không phải object';
  }
  return null;
}
