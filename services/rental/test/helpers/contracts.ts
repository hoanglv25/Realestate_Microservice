import Ajv2020, { ErrorObject, ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { DomainEvent } from '../../src/messaging/domain-event';

/**
 * Kiểm tra event (envelope + payload) khớp schema trong contracts/events/ ở gốc repo.
 * Dùng trong test của service, KHÔNG dùng lúc chạy thật (image Docker không có thư mục contracts):
 *
 *   const event = await outbox.add(manager, 'rental.deposit-created', payload);
 *   expectEventMatchesContract(event);
 */
const CONTRACTS_DIR = resolve(__dirname, '..', '..', '..', '..', 'contracts', 'events');
const OPENAPI_DIR = resolve(__dirname, '..', '..', '..', '..', 'contracts', 'openapi');

let ajv: Ajv2020 | undefined;
const cache = new Map<string, ValidateFunction>();

function validatorFor(eventType: string, version: number): ValidateFunction {
  const file = `${eventType}.v${version}.schema.json`;
  const cached = cache.get(file);
  if (cached) return cached;
  const path = join(CONTRACTS_DIR, file);
  if (!existsSync(path)) {
    throw new Error(
      `Chưa có contract cho ${eventType} v${version} (thiếu contracts/events/${file})`,
    );
  }
  if (!ajv) {
    ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
    ajv.addKeyword('x-producer');
    addFormats(ajv);
    ajv.addSchema(JSON.parse(readFileSync(join(CONTRACTS_DIR, 'envelope.v1.schema.json'), 'utf8')));
  }
  const validate = ajv.compile(JSON.parse(readFileSync(path, 'utf8')));
  cache.set(file, validate);
  return validate;
}

export function expectEventMatchesContract(event: DomainEvent<object>): void {
  const label = `${event.eventType} v${event.version}`;
  const validate = validatorFor(event.eventType, event.version);
  if (!validate(event)) {
    throw new Error(`Event ${label} không khớp contract: ${ajv?.errorsText(validate.errors)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// API nội bộ: response thật phải khớp contracts/openapi/<service>-internal.v1.yaml
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

interface OpenApiSpec {
  doc: Json;
  ajv: Ajv2020;
  prefix: string;
}
const specCache = new Map<string, OpenApiSpec>();

const asRecord = (v: unknown): Json | undefined =>
  typeof v === 'object' && v !== null ? (v as Json) : undefined;

/** Lấy node theo JSON pointer "#/a/b" (giống contracts/scripts/check-openapi.mjs). */
function resolvePointer(doc: Json, ref: string): unknown {
  return ref
    .slice(2)
    .split('/')
    .reduce<unknown>(
      (node, key) => asRecord(node)?.[key.replace(/~1/g, '/').replace(/~0/g, '~')],
      doc,
    );
}

/** Đổi "#/components/schemas/X" thành id riêng để ajv tách được từng schema (giống check-openapi.mjs). */
function rewriteRefs(node: unknown, prefix: string): unknown {
  if (Array.isArray(node)) return node.map((n) => rewriteRefs(n, prefix));
  const rec = asRecord(node);
  if (!rec) return node;
  return Object.fromEntries(
    Object.entries(rec).map(([k, v]) => [
      k,
      k === '$ref' && typeof v === 'string' && v.startsWith('#/components/schemas/')
        ? `${prefix}${v.slice('#/components/schemas/'.length)}`
        : rewriteRefs(v, prefix),
    ]),
  );
}

function loadSpec(file: string, specDir: string): OpenApiSpec {
  const path = join(specDir, file);
  const cached = specCache.get(path);
  if (cached) return cached;
  if (!existsSync(path)) throw new Error(`Không thấy spec OpenAPI: ${path}`);
  const doc = parse(readFileSync(path, 'utf8')) as Json;
  const spec = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
  addFormats(spec);
  const prefix = `https://realestate.local/contracts/openapi/${file}/schemas/`;
  const schemas = asRecord(asRecord(doc.components)?.schemas) ?? {};
  for (const [name, schema] of Object.entries(schemas)) {
    spec.addSchema(rewriteRefs(schema, prefix) as object, `${prefix}${name}`);
  }
  const loaded = { doc, ajv: spec, prefix };
  specCache.set(path, loaded);
  return loaded;
}

/** ajv `errorsText` không nêu tên trường thừa/thiếu, nên tự dựng thông báo có đủ. */
function describeErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((e) => {
      const extra = (e.params as { additionalProperty?: string }).additionalProperty;
      const where = e.instancePath || '(gốc)';
      return `${where} ${e.message}${extra ? ` "${extra}"` : ''}`;
    })
    .join('; ');
}

/**
 * Kiểm body response THẬT khớp schema của (method, path, status) trong `contracts/openapi/<spec>`.
 * `path` viết đúng như trong spec, ví dụ `/internal/users/{id}/bank-account`.
 *
 *   expectResponseMatchesOpenApi(
 *     'identity-internal.v1.yaml', 'GET', '/internal/users/{id}/bank-account', 200, res.body);
 *
 * Bắt được trường thừa khi schema có `additionalProperties: false`, thiếu trường, sai format.
 * Chỉ dùng trong test (cần thư mục contracts và gói `yaml`). `options.specDir` để test chính hàm này.
 */
export function expectResponseMatchesOpenApi(
  specFile: string,
  method: string,
  path: string,
  status: number,
  body: unknown,
  options: { specDir?: string } = {},
): void {
  const label = `${specFile}: ${method.toUpperCase()} ${path} ${status}`;
  const { doc, ajv: spec, prefix } = loadSpec(specFile, options.specDir ?? OPENAPI_DIR);

  const operation = asRecord(asRecord(asRecord(doc.paths)?.[path])?.[method.toLowerCase()]);
  if (!operation) throw new Error(`${label}: không có trong spec`);

  const responses = asRecord(operation.responses) ?? {};
  let response = asRecord(responses[String(status)]);
  if (!response) throw new Error(`${label}: status ${status} không khai báo trong spec`);
  if (typeof response.$ref === 'string') response = asRecord(resolvePointer(doc, response.$ref));

  const media = asRecord(asRecord(response?.content)?.['application/json']);
  if (!media?.schema) throw new Error(`${label}: spec không khai báo body JSON cho status này`);

  const validate = spec.compile(rewriteRefs(media.schema, prefix) as object);
  if (!validate(body)) {
    throw new Error(`${label}: body không khớp hợp đồng: ${describeErrors(validate.errors)}`);
  }
}
