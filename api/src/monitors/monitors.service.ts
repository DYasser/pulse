import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Monitor } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AddressGuardService } from '../worker/address-guard.service';
import { CreateMonitorDto } from './dto/create-monitor.dto';
import { UpdateMonitorDto } from './dto/update-monitor.dto';

/** A monitor plus the state a dashboard needs to render one row. */
export interface MonitorSummary extends Monitor {
  status: 'up' | 'down' | 'paused' | 'pending';
  lastResponseMs: number | null;
  uptime24h: number | null;
  openIncidentSince: Date | null;
}

@Injectable()
export class MonitorsService {
  /** Ceiling on monitors per account, so one user cannot consume every sweep. */
  private readonly MAX_MONITORS_PER_USER = 50;

  constructor(
    private readonly prisma: PrismaService,
    private readonly addressGuard: AddressGuardService,
  ) {}

  async create(userId: string, dto: CreateMonitorDto): Promise<Monitor> {
    await this.assertAddressAllowed(dto.url);

    const existing = await this.prisma.monitor.count({ where: { userId } });
    if (existing >= this.MAX_MONITORS_PER_USER) {
      throw new BadRequestException(
        `A single account may have at most ${this.MAX_MONITORS_PER_USER} monitors`,
      );
    }

    return this.prisma.monitor.create({
      data: { ...dto, userId },
    });
  }

  /**
   * Refuses a URL that resolves into private space.
   *
   * The prober checks again at probe time - it has to, because DNS can be
   * repointed after the monitor is created - but rejecting it here means the user
   * gets told why instead of watching every check fail for an opaque reason.
   */
  private async assertAddressAllowed(url: string): Promise<void> {
    const verdict = await this.addressGuard.check(url);
    if (!verdict.allowed) {
      throw new BadRequestException(
        verdict.reason ?? 'That URL cannot be monitored',
      );
    }
  }

  /**
   * Every read is scoped by userId rather than filtered afterwards, so one user can
   * never see another's monitors even if an id leaks.
   */
  findAll(userId: string): Promise<Monitor[]> {
    return this.prisma.monitor.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(userId: string, id: string): Promise<Monitor> {
    const monitor = await this.prisma.monitor.findFirst({
      where: { id, userId },
    });
    if (!monitor) {
      // 404 rather than 403 for someone else's monitor: a 403 would confirm the id
      // exists, which is information the caller has no right to.
      throw new NotFoundException('Monitor not found');
    }
    return monitor;
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateMonitorDto,
  ): Promise<Monitor> {
    await this.findOne(userId, id);
    if (dto.url) {
      await this.assertAddressAllowed(dto.url);
    }
    return this.prisma.monitor.update({ where: { id }, data: dto });
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.findOne(userId, id);
    // Checks and incidents go with it, via onDelete: Cascade.
    await this.prisma.monitor.delete({ where: { id } });
  }

  /** Recent probe results for one monitor, newest first. */
  async findChecks(userId: string, id: string, limit = 50) {
    await this.findOne(userId, id);
    return this.prisma.check.findMany({
      where: { monitorId: id },
      orderBy: { checkedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  /** Downtime periods for one monitor, newest first. */
  async findIncidents(userId: string, id: string, limit = 20) {
    await this.findOne(userId, id);
    return this.prisma.incident.findMany({
      where: { monitorId: id },
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  /**
   * The dashboard's one call: every monitor with its current state, latest response
   * time and 24-hour uptime.
   *
   * Done as three queries rather than one per monitor - the N+1 here would be
   * three-times-N round trips on a page that reloads often.
   */
  async summary(userId: string): Promise<MonitorSummary[]> {
    const monitors = await this.prisma.monitor.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    if (monitors.length === 0) {
      return [];
    }

    const monitorIds = monitors.map((m) => m.id);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [latestChecks, windowCounts, openIncidents] = await Promise.all([
      // Most recent check per monitor. distinct on an ordered findMany gives the
      // first row of each group, which is what DISTINCT ON would do in raw SQL.
      this.prisma.check.findMany({
        where: { monitorId: { in: monitorIds } },
        orderBy: [{ monitorId: 'asc' }, { checkedAt: 'desc' }],
        distinct: ['monitorId'],
      }),
      this.prisma.check.groupBy({
        by: ['monitorId', 'ok'],
        where: { monitorId: { in: monitorIds }, checkedAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.incident.findMany({
        where: { monitorId: { in: monitorIds }, resolvedAt: null },
      }),
    ]);

    const latestByMonitor = new Map(latestChecks.map((c) => [c.monitorId, c]));
    const incidentByMonitor = new Map(
      openIncidents.map((i) => [i.monitorId, i]),
    );

    const totals = new Map<string, { ok: number; total: number }>();
    for (const row of windowCounts) {
      const entry = totals.get(row.monitorId) ?? { ok: 0, total: 0 };
      const count = row._count._all;
      entry.total += count;
      if (row.ok) {
        entry.ok += count;
      }
      totals.set(row.monitorId, entry);
    }

    return monitors.map((monitor) => {
      const latest = latestByMonitor.get(monitor.id);
      const window = totals.get(monitor.id);
      const incident = incidentByMonitor.get(monitor.id);

      return {
        ...monitor,
        status: this.deriveStatus(monitor.paused, latest?.ok),
        lastResponseMs: latest?.responseMs ?? null,
        // Null rather than 100% when nothing has been probed yet: an unmeasured
        // monitor is not a perfect one.
        uptime24h:
          window && window.total > 0
            ? Math.round((window.ok / window.total) * 1000) / 10
            : null,
        openIncidentSince: incident?.startedAt ?? null,
      };
    });
  }

  private deriveStatus(
    paused: boolean,
    latestOk?: boolean,
  ): MonitorSummary['status'] {
    if (paused) {
      return 'paused';
    }
    if (latestOk === undefined) {
      return 'pending';
    }
    return latestOk ? 'up' : 'down';
  }
}
