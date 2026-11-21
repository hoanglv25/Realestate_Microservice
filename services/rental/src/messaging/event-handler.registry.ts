import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import type { DomainEvent } from './domain-event';

/**
 * Xử lý một event. `manager` thuộc transaction đã ghi eventId vào inbox: mọi thay đổi dữ liệu
 * PHẢI đi qua `manager` này để "xử lý" và "đánh dấu đã xử lý" cùng commit hoặc cùng rollback.
 * Muốn phát event tiếp theo thì gọi `outbox.add(manager, ...)` với chính manager này.
 */
export type EventHandler<TPayload extends object = Record<string, unknown>> = (
  event: DomainEvent<TPayload>,
  manager: EntityManager,
) => Promise<void>;

/**
 * Ném lỗi này khi biết chắc thử lại cũng vô ích (dữ liệu sai, vi phạm nghiệp vụ không thể sửa):
 * message vào DLQ ngay, không retry.
 */
export class NonRetryableEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableEventError';
  }
}

/**
 * Nơi module nghiệp vụ đăng ký handler theo eventType (đăng ký trong onModuleInit):
 *
 *   constructor(private readonly events: EventHandlerRegistry) {}
 *   onModuleInit() {
 *     this.events.on<PaymentDeposited>('payment.deposited', (e, manager) => this.onDeposited(e, manager));
 *   }
 *
 * Event có trên queue mà không có handler thì được ack và bỏ qua.
 */
@Injectable()
export class EventHandlerRegistry {
  private readonly handlers = new Map<string, EventHandler>();

  on<TPayload extends object>(eventType: string, handler: EventHandler<TPayload>): void {
    if (this.handlers.has(eventType)) {
      throw new Error(`Đã có handler cho event "${eventType}"`);
    }
    this.handlers.set(eventType, handler as unknown as EventHandler);
  }

  get(eventType: string): EventHandler | undefined {
    return this.handlers.get(eventType);
  }

  eventTypes(): string[] {
    return [...this.handlers.keys()];
  }
}
