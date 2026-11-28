import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

/** Chỗ nhận `sendMail` của nodemailer (test thay bằng bản giả; module nối với `createTransport` thật). */
export interface MailTransport {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<unknown>;
}

/** Token DI của transport SMTP. */
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');
/** Token DI của cấu hình MailService. */
export const MAIL_OPTIONS = Symbol('MAIL_OPTIONS');

export interface MailOptions {
  /** `MAIL_FROM`. */
  from: string;
  /** Hiện trong nội dung email OTP. */
  otpTtlSeconds: number;
  /** Hiện trong nội dung email đặt lại mật khẩu. */
  resetTtlSeconds: number;
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const minutes = (seconds: number): string => `${Math.max(1, Math.round(seconds / 60))} phút`;

/**
 * Gửi email qua SMTP (cấu hình ở `.env`; dev dùng Gmail App Password).
 *
 * KHÔNG CHỜ (`API_Spec §1.1`, chốt 2026-11-20): `sendOtp`, `sendPasswordReset` trả về ngay, việc gửi chạy nền.
 * Lỗi chỉ ghi log `warn` và không bao giờ ném ra cho người gọi, nên kết quả `201`/`202` không phụ thuộc SMTP
 * và độ trễ không lộ email nào có tài khoản.
 *
 * Log KHÔNG chứa OTP, link (có token), địa chỉ nhận, hay thông điệp lỗi gốc (SMTP hay chép lại địa chỉ nhận
 * vào lỗi): chỉ `code`, `responseCode`, tên lỗi (`security-policy.md §1, §5`).
 */
@Injectable()
export class MailService {
  constructor(
    private readonly transport: MailTransport,
    private readonly options: MailOptions,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MailService.name);
  }

  sendOtp(email: string, otp: string): void {
    const ttl = minutes(this.options.otpTtlSeconds);
    const text =
      `Mã xác minh email của bạn là: ${otp}\n\n` +
      `Mã có hiệu lực trong ${ttl}. Nhập sai quá số lần cho phép thì mã bị hủy và bạn cần yêu cầu gửi lại.\n` +
      'Nếu bạn không đăng ký tài khoản, hãy bỏ qua email này.';
    const html =
      `<p>Mã xác minh email của bạn là:</p><p style="font-size:24px;letter-spacing:4px"><b>${escapeHtml(otp)}</b></p>` +
      `<p>Mã có hiệu lực trong ${ttl}. Nhập sai quá số lần cho phép thì mã bị hủy và bạn cần yêu cầu gửi lại.</p>` +
      '<p>Nếu bạn không đăng ký tài khoản, hãy bỏ qua email này.</p>';
    this.dispatch('otp', email, 'Mã xác minh email', text, html);
  }

  sendPasswordReset(email: string, link: string): void {
    const ttl = minutes(this.options.resetTtlSeconds);
    const text =
      `Bạn vừa yêu cầu đặt lại mật khẩu. Mở liên kết sau để đặt mật khẩu mới (hiệu lực ${ttl}, dùng một lần):\n\n${link}\n\n` +
      'Nếu không phải bạn yêu cầu, hãy bỏ qua email này; mật khẩu hiện tại không đổi.';
    const html =
      `<p>Bạn vừa yêu cầu đặt lại mật khẩu. Mở liên kết sau để đặt mật khẩu mới (hiệu lực ${ttl}, dùng một lần):</p>` +
      `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` +
      '<p>Nếu không phải bạn yêu cầu, hãy bỏ qua email này; mật khẩu hiện tại không đổi.</p>';
    this.dispatch('password-reset', email, 'Yêu cầu đặt lại mật khẩu', text, html);
  }

  /** Gửi nền: mọi lỗi (kể cả ném đồng bộ) chỉ thành một dòng log `warn`. */
  private dispatch(
    template: string,
    to: string,
    subject: string,
    text: string,
    html: string,
  ): void {
    let sending: Promise<unknown>;
    try {
      sending = this.transport.sendMail({ from: this.options.from, to, subject, text, html });
    } catch (err) {
      sending = Promise.reject(err);
    }
    sending.catch((err: unknown) => {
      const e = (err ?? {}) as { name?: unknown; code?: unknown; responseCode?: unknown };
      this.logger.warn(
        { template, errName: e.name, errCode: e.code, responseCode: e.responseCode },
        'Gửi email thất bại',
      );
    });
  }
}
