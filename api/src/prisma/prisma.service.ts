import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Owns the single database connection pool for the process.
 *
 * Prisma 7 connects through a driver adapter rather than a URL in the schema, so the
 * pool is configured here. Nest tears it down on shutdown, which matters on a small
 * instance: Postgres connection limits are the first thing you run out of when
 * redeploys leave pools behind.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Empties every table. Used only by the integration tests, between cases.
   * Truncate rather than delete so cascades are honoured in one statement.
   */
  async truncateAll(): Promise<void> {
    await this.$executeRawUnsafe(
      'TRUNCATE TABLE "incidents", "checks", "monitors", "users" RESTART IDENTITY CASCADE',
    );
  }
}
