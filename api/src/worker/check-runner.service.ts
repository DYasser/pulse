import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Monitor } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProberService } from './prober.service';

@Injectable()
export class CheckRunnerService {
  private readonly logger = new Logger(CheckRunnerService.name);

  /**
   * Consecutive failures before an incident opens.
   *
   * One failure is not an outage: a single dropped packet or a brief deploy would
   * otherwise page you at 3am. Two in a row is the smallest threshold that filters
   * transient noise while still catching a real outage within one interval.
   */
  private readonly failureThreshold: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly prober: ProberService,
    config: ConfigService,
  ) {
    this.failureThreshold = Number(config.get('FAILURE_THRESHOLD') ?? 2);
  }

  /**
   * Probes one monitor, records the result, and opens or closes an incident.
   *
   * Returns the recorded check so callers (and tests) can assert on it without
   * re-reading the database.
   */
  async runCheck(monitor: Monitor) {
    const result = await this.prober.probe(
      monitor.url,
      monitor.expectedStatus,
      monitor.timeoutMs,
    );

    const check = await this.prisma.check.create({
      data: {
        monitorId: monitor.id,
        statusCode: result.statusCode,
        responseMs: result.responseMs,
        ok: result.ok,
        error: result.error,
      },
    });

    // Stamped even on failure: the scheduler uses this to decide who is due, and a
    // monitor whose site is down must not be probed on a tight loop.
    await this.prisma.monitor.update({
      where: { id: monitor.id },
      data: { lastCheckedAt: check.checkedAt },
    });

    if (result.ok) {
      await this.resolveOpenIncident(monitor.id, check.checkedAt);
    } else {
      await this.recordFailure(
        monitor.id,
        result.error,
        check.checkedAt,
        monitor.intervalSec,
      );
    }

    return check;
  }

  /**
   * Closes the open incident, if there is one.
   *
   * Recovery is immediate and unconditional - one success means it is up. The
   * asymmetry with the failure threshold is deliberate: being slow to declare an
   * outage avoids false alarms, but being slow to declare recovery just means
   * lying about the current state.
   */
  private async resolveOpenIncident(
    monitorId: string,
    at: Date,
  ): Promise<void> {
    const open = await this.prisma.incident.findFirst({
      where: { monitorId, resolvedAt: null },
    });

    if (!open) {
      return;
    }

    await this.prisma.incident.update({
      where: { id: open.id },
      data: { resolvedAt: at },
    });

    const downForMs = at.getTime() - open.startedAt.getTime();
    this.logger.log(
      `Monitor ${monitorId} recovered after ${Math.round(downForMs / 1000)}s`,
    );
  }

  /**
   * Counts the failure and opens an incident once the threshold is met.
   *
   * The count comes from the checks table rather than a counter column, so it stays
   * correct if a check is recorded by something other than this path, and cannot
   * drift out of sync with the history a user can read.
   */
  private async recordFailure(
    monitorId: string,
    cause: string | null,
    at: Date,
    intervalSec: number,
  ): Promise<void> {
    const open = await this.prisma.incident.findFirst({
      where: { monitorId, resolvedAt: null },
    });

    if (open) {
      await this.prisma.incident.update({
        where: { id: open.id },
        data: { failureCount: { increment: 1 } },
      });
      return;
    }

    // Bounded in time as well as in count. Without the window, a monitor paused
    // for a month with one failing check as its last record would, on being
    // unpaused, treat that month-old failure as "consecutive" with the new one and
    // open an incident whose startedAt is meaningless. The allowance is generous -
    // several intervals - so a slow monitor still accumulates a streak.
    const windowStart = new Date(
      at.getTime() - intervalSec * 1000 * (this.failureThreshold + 1),
    );

    const recent = await this.prisma.check.findMany({
      where: { monitorId, checkedAt: { gte: windowStart } },
      orderBy: { checkedAt: 'desc' },
      take: this.failureThreshold,
      select: { ok: true },
    });

    const enoughHistory = recent.length >= this.failureThreshold;
    const allFailed = recent.every((check) => !check.ok);

    if (enoughHistory && allFailed) {
      await this.prisma.incident.create({
        data: {
          monitorId,
          startedAt: at,
          cause,
          // The count of failures that actually opened this incident.
          failureCount: recent.length,
        },
      });
      this.logger.warn(`Monitor ${monitorId} is down: ${cause ?? 'unknown'}`);
    }
  }
}
