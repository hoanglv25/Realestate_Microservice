import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { EnvVars } from './config/env.validation';
import { getServiceVersion } from './config/service-info';

export const SWAGGER_PATH = 'api/docs';

/** Dựng tài liệu OpenAPI từ controller (dùng cho Swagger UI và `pnpm openapi:export`). */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = app.get<ConfigService<EnvVars, true>>(ConfigService);
  const options = new DocumentBuilder()
    .setTitle(`${config.get('SERVICE_NAME', { infer: true })} API`)
    .setDescription('API công khai /api/v1 (API nội bộ /internal không nằm trong tài liệu này)')
    .setVersion(getServiceVersion())
    .addBearerAuth()
    .build();
  return SwaggerModule.createDocument(app, options);
}

/** Swagger UI ở /api/docs và JSON ở /api/docs-json. Tắt bằng SWAGGER_ENABLED=false. */
export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup(SWAGGER_PATH, app, buildOpenApiDocument(app));
}
