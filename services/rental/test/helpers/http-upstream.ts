import { Body, Controller, Delete, Get, Post, Put, Query } from '@nestjs/common';
import { createServer, IncomingHttpHeaders, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Public } from '../../src/common/auth/public.decorator';
import { InternalHttpService } from '../../src/common/http/internal-http.service';

// ---------- Upstream giả: một HTTP server thật trên cổng ngẫu nhiên ----------
export interface Seen {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
}

let upstream: Server;
let baseUrl = '';
export const seen: Seen[] = [];
export const counters = new Map<string, number>();
export const hitsOf = (path: string): number => seen.filter((s) => s.path === path).length;
export const resetUpstream = (): void => {
  seen.length = 0;
  counters.clear();
};

export function startUpstream(): Promise<void> {
  upstream = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://upstream');
    seen.push({ method: req.method ?? '', path: url.pathname, headers: req.headers });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // Service đích dùng template nên trả đúng khung { data, meta } cho thành công
    const ok = (data: unknown) =>
      json(200, {
        data,
        meta: { correlationId: 'upstream-own', timestamp: new Date().toISOString() },
      });

    switch (url.pathname) {
      case '/ok':
        return ok({ ok: true, method: req.method, requestId: req.headers['x-request-id'] });
      case '/flaky': {
        // Lỗi 503 cho tới khi đủ số lần `fail`, sau đó thành công
        const id = url.searchParams.get('id') ?? '';
        const n = (counters.get(id) ?? 0) + 1;
        counters.set(id, n);
        return n <= Number(url.searchParams.get('fail'))
          ? json(503, { x: 1 })
          : ok({ ok: true, attempts: n });
      }
      case '/always503':
        return json(503, {});
      case '/always500':
        return json(500, { stack: 'boom tại /srv/upstream.ts' });
      case '/always504':
        return json(504, {});
      case '/conflict':
        return json(409, {
          error: {
            code: 'DEPOSIT_ALREADY_PAID',
            message: 'Đơn đặt cọc đã được thanh toán',
            details: { depositId: 'd-1' },
          },
          meta: { correlationId: 'upstream-own', timestamp: new Date().toISOString() },
        });
      case '/plain404':
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not here');
      case '/slow':
        return void setTimeout(() => ok({ ok: true }), 600);
      default:
        return json(404, {});
    }
  });
  return new Promise((resolve) =>
    upstream.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

export function stopUpstream(): Promise<void> {
  return new Promise((resolve) => upstream.close(() => resolve()));
}

// ---------- Controller test: gọi upstream qua InternalHttpService ----------
@Public()
@Controller('test-http')
export class TestHttpController {
  constructor(private readonly http: InternalHttpService) {}

  @Get('get')
  get(@Query('path') path: string): Promise<unknown> {
    return this.http.get(`${baseUrl}${path}`);
  }

  @Post('post')
  post(
    @Query('path') path: string,
    @Query('idem') idem: string,
    @Body() body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.http.post(`${baseUrl}${path}`, body, { idempotent: idem === '1' });
  }

  @Put('put')
  put(@Query('path') path: string, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.http.put(`${baseUrl}${path}`, body);
  }

  @Delete('delete')
  remove(@Query('path') path: string): Promise<unknown> {
    return this.http.delete(`${baseUrl}${path}`);
  }

  @Get('timeout')
  timeout(): Promise<unknown> {
    return this.http.get(`${baseUrl}/slow`, { timeoutMs: 150 });
  }

  @Get('default-timeout')
  defaultTimeout(): Promise<unknown> {
    return this.http.get(`${baseUrl}/slow`);
  }

  @Get('refused')
  refused(): Promise<unknown> {
    return this.http.get('http://127.0.0.1:1/x');
  }

  @Post('refused-post')
  refusedPost(@Body() body: Record<string, unknown>): Promise<unknown> {
    return this.http.post('http://127.0.0.1:1/x', body);
  }
}
