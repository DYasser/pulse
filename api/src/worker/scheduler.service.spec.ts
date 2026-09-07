import { Test } from '@nestjs/testing';
import { Monitor } from '@prisma/client';
import { SchedulerService } from './scheduler.service';
import { CheckRunnerService } from './check-runner.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Which monitors a sweep picks up, against a real database.
 *
 * The due-ness test is SQL, so it can only be verified against Postgres - an
 * in-memory stub would be testing the stub's idea of interval arithmetic.
 */
describe('SchedulerService', () => {
  let scheduler: SchedulerService;
  let prisma: PrismaService;
  let userId: string;

  /** Monitors handed to the runner during the last sweep. */
  let probed: Monitor[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        SchedulerService,
        PrismaService,
        {
          provide: CheckRunnerService,
          useValue: {
            runCheck: (monitor: Monitor) => {
              probed.push(monitor);
              return Promise.resolve({});
            },
          },
        },
      ],
    }).compile();

    scheduler = moduleRef.get(SchedulerService);
    prisma = moduleRef.get(PrismaService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.truncateAll();
    probed = [];
    const user = await prisma.user.create({
      data: { email: `sched-${Date.now()}@test.local`, passwordHash: 'x' },
    });
    userId = user.id;
  });

  function makeMonitor(overrides: Partial<Monitor> = {}) {
    return prisma.monitor.create({
      data: {
        userId,
        name: overrides.name ?? 'Test',
        url: overrides.url ?? 'https://example.com',
        intervalSec: overrides.intervalSec ?? 300,
        paused: overrides.paused ?? false,
        lastCheckedAt: overrides.lastCheckedAt ?? null,
        timeoutMs: overrides.timeoutMs ?? 10_000,
        expectedStatus: overrides.expectedStatus ?? 200,
      },
    });
  }

  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

  describe('choosing what to probe', () => {
    it('probes a monitor that has never been checked', async () => {
      await makeMonitor();

      await scheduler.sweep();

      expect(probed.length).toBe(1);
    });

    it('probes a monitor whose interval has elapsed', async () => {
      await makeMonitor({ intervalSec: 300, lastCheckedAt: minutesAgo(10) });

      await scheduler.sweep();

      expect(probed.length).toBe(1);
    });

    it('leaves a monitor alone until its interval is up', async () => {
      // Checked one minute ago on a five-minute interval: not due.
      await makeMonitor({ intervalSec: 300, lastCheckedAt: minutesAgo(1) });

      await scheduler.sweep();

      expect(probed).toEqual([]);
    });

    it('skips paused monitors however stale they are', async () => {
      await makeMonitor({ paused: true, lastCheckedAt: minutesAgo(600) });

      await scheduler.sweep();

      expect(probed).toEqual([]);
    });

    it("respects each monitor's own interval", async () => {
      await makeMonitor({
        name: 'Frequent',
        intervalSec: 60,
        lastCheckedAt: minutesAgo(5),
      });
      await makeMonitor({
        name: 'Hourly',
        intervalSec: 3600,
        lastCheckedAt: minutesAgo(5),
      });

      await scheduler.sweep();

      expect(probed.map((m) => m.name)).toEqual(['Frequent']);
    });

    it('does nothing when there is nothing to do', async () => {
      await expect(scheduler.sweep()).resolves.toBeUndefined();
      expect(probed).toEqual([]);
    });
  });

  describe('what the runner receives', () => {
    it('hands over fully populated monitors', async () => {
      // Regression: the due-ness query is raw SQL, and $queryRaw bypasses the
      // schema's @map translation - it returns snake_case columns. Casting that
      // result to Monitor type-checked but left every camelCase field undefined, so
      // the prober was called with timeoutMs undefined and every probe aborted
      // immediately with "No response within undefinedms".
      await makeMonitor({
        timeoutMs: 7500,
        intervalSec: 120,
        expectedStatus: 204,
      });

      await scheduler.sweep();

      const [monitor] = probed;
      expect(monitor.timeoutMs).toBe(7500);
      expect(monitor.intervalSec).toBe(120);
      expect(monitor.expectedStatus).toBe(204);
      expect(monitor.userId).toBe(userId);
      expect(monitor.url).toBe('https://example.com');
    });

    it('leaves no field undefined', async () => {
      await makeMonitor();

      await scheduler.sweep();

      for (const [key, value] of Object.entries(probed[0])) {
        // lastCheckedAt is legitimately null on a monitor never checked; undefined
        // is what a mapping failure looks like.
        expect(value).not.toBeUndefined();
        expect(key).not.toContain('_'); // camelCase, not raw columns
      }
    });
  });

  describe('overlapping sweeps', () => {
    it('skips a tick while the previous sweep is still running', async () => {
      // A sweep slower than the cron interval must not run twice concurrently and
      // double-probe every monitor.
      await makeMonitor();

      await Promise.all([scheduler.sweep(), scheduler.sweep()]);

      expect(probed.length).toBe(1);
    });
  });
});
