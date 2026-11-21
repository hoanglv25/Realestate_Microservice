import { Controller, Get, Res, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorFunction,
  HealthIndicatorService,
} from '@nestjs/terminus';
import type { Response } from 'express';
import { Public } from '../common/auth/public.decorator';
import { RawResponse } from '../common/response/raw-response.decorator';
import { EnvVars } from '../config/env.validation';
import { getServiceVersion } from '../config/service-info';
import { HealthProbe, HealthRegistry } from './health.registry';

type CheckState = 'up' | 'down';

export interface HealthResponse {
  status: 'ok' | 'error';
  service: string;
  version: string;
  /** Số giây service đã chạy. */
  uptime: number;
  /** Chỉ chứa các phụ thuộc đang bật (db, redis, ...). */
  checks: Record<string, CheckState>;
}

/** Mỗi probe có tối đa 2 giây; quá hạn coi như chết để /health luôn trả lời nhanh. */
const PROBE_TIMEOUT_MS = 2000;

function runProbe(probe: HealthProbe): Promise<boolean> {
  const timeout = new Promise<boolean>((resolve) =>
    setTimeout(() => resolve(false), PROBE_TIMEOUT_MS).unref(),
  );
  return Promise.race([probe().catch(() => false), timeout]);
}

@ApiTags('health')
@Public() // Docker/hạ tầng gọi không kèm token
@RawResponse() // body phẳng cho Docker HEALTHCHECK và công cụ giám sát, không bọc { data, meta }
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService,
    private readonly registry: HealthRegistry,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  /**
   * /health: cho Docker HEALTHCHECK và hạ tầng (không qua gateway).
   * /api/v1/health: alias cùng nội dung.
   * 200 khi mọi phụ thuộc ổn, 503 khi có phụ thuộc chết.
   */
  @Get(['health', 'api/v1/health'])
  @ApiOperation({ summary: 'Trạng thái service và các phụ thuộc đang bật' })
  @ApiOkResponse({ description: 'Mọi phụ thuộc ổn' })
  @ApiServiceUnavailableResponse({ description: 'Có phụ thuộc chết (checks.<tên> = "down")' })
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const functions: HealthIndicatorFunction[] = this.registry.entries().map(([name, probe]) => {
      return async () => {
        const session = this.indicators.check(name);
        return (await runProbe(probe)) ? session.up() : session.down();
      };
    });

    let result: HealthCheckResult;
    try {
      result = await this.health.check(functions);
    } catch (error) {
      // Terminus ném 503 kèm kết quả đầy đủ; ta tự dựng body theo format dự án thay vì body mặc định
      if (!(error instanceof ServiceUnavailableException)) throw error;
      result = error.getResponse() as HealthCheckResult;
    }

    const checks: Record<string, CheckState> = {};
    for (const [name, detail] of Object.entries(result.details ?? {})) {
      checks[name] = detail.status === 'up' ? 'up' : 'down';
    }
    const ok = Object.values(checks).every((state) => state === 'up');
    res.status(ok ? 200 : 503);

    return {
      status: ok ? 'ok' : 'error',
      service: this.config.get('SERVICE_NAME', { infer: true }),
      version: getServiceVersion(),
      uptime: Math.round(process.uptime()),
      checks,
    };
  }
}
