import type { MailTransport } from '../../src/identity/services/mail.service';
import { waitFor } from './infra';

/**
 * Bắt email của identity trong bộ nhớ thay cho SMTP thật (C27: không còn Mailpit).
 * `startIdentityInfra` thay provider `MAIL_TRANSPORT` bằng `captureTransport`, nên `MailService`, nội dung
 * thư và việc gửi KHÔNG chờ (API_Spec §1.1) giữ nguyên; chỉ bước giao cho máy chủ SMTP được bỏ qua.
 * Gửi chạy nền nên test vẫn phải HỎI LẠI vài lần cho tới khi thư tới (`waitForMails`).
 */
export interface CapturedMail {
  /** Địa chỉ người gửi (phần trong `<…>` nếu `MAIL_FROM` có tên hiển thị). */
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
}

// Mỗi file test chạy trong registry module riêng của Jest, nên danh sách này không lẫn giữa các file.
const sent: CapturedMail[] = [];

const addressOf = (value: string): string => (/<([^>]+)>/.exec(value)?.[1] ?? value).trim();

/** Transport giả: ghi thư vào bộ nhớ (mới nhất trước), không mở kết nối mạng. */
export const captureTransport: MailTransport = {
  sendMail(message) {
    sent.unshift({
      from: addressOf(message.from),
      to: [addressOf(message.to)],
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return Promise.resolve({ accepted: [message.to] });
  },
};

/** Xóa thư đã bắt (gọi khi dọn app test). */
export function clearCapturedMails(): void {
  sent.length = 0;
}

/** Mọi thư gửi tới `email`, không phân biệt hoa thường (mới nhất trước). */
export function mailsTo(email: string): Promise<CapturedMail[]> {
  const target = email.toLowerCase();
  return Promise.resolve(sent.filter((m) => m.to.some((to) => to.toLowerCase() === target)));
}

/** Chờ (hỏi lại mỗi 100ms) tới khi có ít nhất `count` thư gửi tới `email`. */
export function waitForMails(email: string, count = 1, timeoutMs = 10000): Promise<CapturedMail[]> {
  return waitFor(
    async () => {
      const mails = await mailsTo(email);
      return mails.length >= count ? mails : null;
    },
    `${count} email gửi tới ${email}`,
    timeoutMs,
  );
}

/** Mã OTP 6 chữ số trong nội dung thư. */
export function otpOf(mail: CapturedMail): string {
  const match = /\b(\d{6})\b/.exec(mail.text);
  if (!match) throw new Error(`Không thấy OTP trong thư: ${mail.text}`);
  return match[1];
}

/** Token đặt lại mật khẩu trong link của thư. */
export function resetTokenOf(mail: CapturedMail): string {
  const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(mail.text);
  if (!match) throw new Error(`Không thấy link đặt lại trong thư: ${mail.text}`);
  return match[1];
}

/** Khẳng định KHÔNG có thư nào gửi tới `email` (chờ `settleMs` cho việc gửi nền kịp xảy ra nếu có). */
export async function expectNoMail(email: string, settleMs = 600): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const mails = await mailsTo(email);
  if (mails.length > 0)
    throw new Error(`Không được có thư gửi tới ${email}, nhưng có ${mails.length}`);
}
