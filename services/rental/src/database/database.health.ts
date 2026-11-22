import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { HealthRegistry } from '../health/health.registry';

/** Đăng ký health check 'db' (SELECT 1) khi DatabaseModule được bật. */
@Injectable()
export class DatabaseHealthRegistrar implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly registry: HealthRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register('db', async () => {
      await this.dataSource.query('SELECT 1');
      return true;
    });
  }
}
