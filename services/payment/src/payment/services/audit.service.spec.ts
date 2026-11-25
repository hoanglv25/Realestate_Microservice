import { AuditService } from './audit.service';

const ADMIN = '66666666-6666-4666-8666-666666666666';
const TARGET = '55555555-5555-4555-8555-555555555555';

describe('AuditService.log (RE.PAYOUT §1.3, test 14)', () => {
  it('một truy vấn INSERT audit_log trong manager của bên gọi; before/after là JSON', async () => {
    const m = { query: jest.fn().mockResolvedValue([]) };
    await new AuditService().log(m as never, {
      actorId: ADMIN,
      action: 'COMPLETE_WITHDRAWAL',
      targetType: 'WITHDRAWAL',
      targetId: TARGET,
      before: { status: 'PENDING' },
      after: { status: 'COMPLETED', receiptId: 'R1' },
    });
    expect(m.query).toHaveBeenCalledTimes(1);
    const [sql, params] = m.query.mock.calls[0] as [string, unknown[]];
    expect(sql.replace(/\s+/g, ' ').trim()).toMatch(/^INSERT INTO audit_log/);
    expect(params).toEqual([
      ADMIN,
      'COMPLETE_WITHDRAWAL',
      'WITHDRAWAL',
      TARGET,
      '{"status":"PENDING"}',
      '{"status":"COMPLETED","receiptId":"R1"}',
      null, // correlation_id: ngoài request không có
    ]);
  });
});
