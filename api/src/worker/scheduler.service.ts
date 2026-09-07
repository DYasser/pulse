import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Monitor } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CheckRunnerService } from './check-runner.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  /**
   * How many probes may be in flight at once.
   *
   * Each probe is mostly idle waiting on the network, so this is not about CPU: it
   * bounds open sockets and database connections. Firing 500 probes at once would
   * exhaust the connection pool long before it saturated the event loop.
   */
  private readonly CONCURRENCY = 10;

  /** Guards against a slow sweep still running when the next tick fires. */
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: CheckRunnerService,
  ) {}

  /**
   * Runs every minute; each monitor's own interval decides whether it is actually
   * due. A single frequent tick is simpler and more robust than a timer per
   * monitor, which would have to be rebuilt whenever a monitor changed.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'sweep' })
  async sweep(): Promise<void> {
    if (this.sweeping) {
      this.logger.warn('Previous sweep still running; skipping this tick');
      return;
    }

    this.sweeping = true;
    try {
      const due = await this.findDueMonitors();
      if (due.length === 0) {
        return;
      }

      const results = await this.runBatched(due);
      const failed = results.filter((r) => r.status === 'rejected').length;

      this.logger.log(
        `Swept ${due.length} monitor(s)` +
          (failed > 0 ? `, ${failed} errored` : ''),
      );
    } finally {
      // In a finally so a thrown error cannot wedge the scheduler permanently.
      this.sweeping = false;
    }
  }

  /**
   * Monitors whose interval has elapsed.
   *
   * The due-ness test is done in SQL because `last_checked_at + interval_sec` is a
   * per-row comparison Prisma's query builder cannot express. Only ids are selected:
   * $queryRaw bypasses the @map translation in the schema and hands back raw
   * snake_case columns, so a `$queryRaw<Monitor[]>` would type-check while leaving
   * every camelCase field undefined at runtime. Selecting ids and re-reading through
   * the client keeps one mapping path instead of two.
   */
  private async findDueMonitors(): Promise<Monitor[]> {
    const due = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM monitors
      WHERE paused = false
        AND (
          last_checked_at IS NULL
          OR last_checked_at + (interval_sec * INTERVAL '1 second') <= NOW()
        )
      ORDER BY last_checked_at ASC NULLS FIRST
      LIMIT 500
    `;

    if (due.length === 0) {
      return [];
    }

    return this.prisma.monitor.findMany({
      where: { id: { in: due.map((row) => row.id) } },
    });
  }

  /**
   * Probes in fixed-size batches.
   *
   * allSettled rather than all: one monitor whose probe throws unexpectedly must
   * not abandon the rest of the batch.
   */
  private async runBatched(
    monitors: Monitor[],
  ): Promise<PromiseSettledResult<unknown>[]> {
    const results: PromiseSettledResult<unknown>[] = [];

    for (let i = 0; i < monitors.length; i += this.CONCURRENCY) {
      const batch = monitors.slice(i, i + this.CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((monitor) => this.runner.runCheck(monitor)),
      );

      for (const result of settled) {
        if (result.status === 'rejected') {
          this.logger.error(
            `Check failed unexpectedly: ${String(result.reason)}`,
          );
        }
      }
      results.push(...settled);
    }

    return results;
  }
}
