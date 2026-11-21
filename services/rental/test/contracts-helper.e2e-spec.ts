import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectResponseMatchesOpenApi } from './helpers/contracts';

/**
 * Kiểm chính hàm `expectResponseMatchesOpenApi` bằng một spec nhỏ dựng tạm (không phụ thuộc
 * contracts/ của service cụ thể).
 */
const SPEC = `
openapi: 3.1.0
info: { title: Tạm, version: 1.0.0 }
paths:
  /internal/things/{id}:
    get:
      operationId: getThing
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ThingResponse' }
              example: {}
        '400':
          $ref: '#/components/responses/BadRequest'
components:
  responses:
    BadRequest:
      description: sai id
      content:
        application/json:
          schema: { $ref: '#/components/schemas/ErrorResponse' }
          example: {}
  schemas:
    Thing:
      type: object
      additionalProperties: false
      required: [id, name]
      properties:
        id: { type: string, format: uuid }
        name: { type: string, minLength: 1 }
    ThingResponse:
      type: object
      required: [data, meta]
      properties:
        data: { $ref: '#/components/schemas/Thing' }
        meta: { $ref: '#/components/schemas/Meta' }
    Meta:
      type: object
      required: [correlationId, timestamp]
      properties:
        correlationId: { type: string }
        timestamp: { type: string, format: date-time }
    ErrorResponse:
      type: object
      required: [error, meta]
      properties:
        error:
          type: object
          required: [code, message]
          properties:
            code: { type: string, pattern: '^[A-Z][A-Z0-9_]*$' }
            message: { type: string }
        meta: { $ref: '#/components/schemas/Meta' }
`;

const META = { correlationId: 'abc', timestamp: '2026-11-19T03:00:00.000Z' };
const ID = '0b0a8b5e-7f9e-4c3a-9d2a-2f5f4b9c1a11';
const PATH = '/internal/things/{id}';

describe('expectResponseMatchesOpenApi', () => {
  let specDir: string;
  const check = (status: number, body: unknown, method = 'GET', path = PATH) =>
    expectResponseMatchesOpenApi('things.v1.yaml', method, path, status, body, { specDir });

  beforeAll(() => {
    specDir = mkdtempSync(join(tmpdir(), 'openapi-helper-'));
    writeFileSync(join(specDir, 'things.v1.yaml'), SPEC);
  });
  afterAll(() => rmSync(specDir, { recursive: true, force: true }));

  it('body khớp schema ($ref lồng nhau) -> không ném lỗi', () => {
    expect(() => check(200, { data: { id: ID, name: 'A' }, meta: META })).not.toThrow();
  });

  it('thừa trường khi schema có additionalProperties:false -> ném lỗi nêu tên trường', () => {
    expect(() => check(200, { data: { id: ID, name: 'A', updatedAt: 'x' }, meta: META })).toThrow(
      /updatedAt/,
    );
  });

  it('thiếu trường bắt buộc -> ném lỗi', () => {
    expect(() => check(200, { data: { id: ID }, meta: META })).toThrow(/name/);
  });

  it('sai format (uuid, date-time) -> ném lỗi', () => {
    expect(() => check(200, { data: { id: 'x', name: 'A' }, meta: META })).toThrow(/uuid/);
    expect(() =>
      check(200, { data: { id: ID, name: 'A' }, meta: { ...META, timestamp: 'hôm qua' } }),
    ).toThrow(/date-time/);
  });

  it('response khai qua components/responses ($ref) vẫn kiểm được', () => {
    const ok = { error: { code: 'VALIDATION_FAILED', message: 'id phải là UUID' }, meta: META };
    expect(() => check(400, ok)).not.toThrow();
    expect(() => check(400, { ...ok, error: { code: 'viết thường', message: 'x' } })).toThrow(
      /pattern/,
    );
  });

  it('status chưa khai trong spec -> ném lỗi rõ ràng', () => {
    expect(() => check(404, {})).toThrow(/404.*không khai báo|không khai báo.*404/);
  });

  it('đường dẫn hoặc method không có trong spec -> ném lỗi rõ ràng', () => {
    expect(() => check(200, {}, 'GET', '/internal/khac')).toThrow(/không có/);
    expect(() => check(200, {}, 'POST')).toThrow(/không có/);
  });

  it('thiếu file spec -> ném lỗi rõ ràng', () => {
    expect(() =>
      expectResponseMatchesOpenApi('khong-co.yaml', 'GET', PATH, 200, {}, { specDir }),
    ).toThrow(/khong-co\.yaml/);
  });
});
