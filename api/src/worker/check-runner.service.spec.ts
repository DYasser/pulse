import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Monitor } from '@prisma/client';
import { CheckRunnerService } from './check-runner.service';
import { ProberService, ProbeResult } from './prober.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Incident derivation, against a real database.
 *
 * The prober is stubbed - the point of these cases is what a *sequence* of results
 * does to the incidents table, and real HTTP would make that untestable. Everything
 * below the prober is genuine: real inserts, real queries, real cascades.
 */
describe('CheckRunnerService', () => {
  let runner: CheckRunnerService;
  let prisma: PrismaService;
  let nextResult: ProbeResult;
  let monitor: Monitor;

  const up: ProbeResult = {
    ok: true,
    statusCode: 200,
    responseMs: 120,
    error: null,
  };
  const down: ProbeResult = {
    ok: false,
    statusCode: 503,
    responseMs: 90,
    error: 'Expected 200, got 503',
  };
  const timedOut: ProbeResult = {
    ok: false,
    statusCode: null,
    responseMs: 2000,
    error: 'No response within 2000ms',
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        CheckRunnerService,
        PrismaService,
        {
          provide: ProberService,
          useValue: { probe: () => Promise.resolve(nextResult) },
        },
        { provide: ConfigService, useValue: { get: () => 2 } },
      ],
    }).compile();

    runner = moduleRef.get(CheckRunnerService);
    prisma = moduleRef.get(PrismaService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.truncateAll();
    const user = await prisma.user.create({
      data: { email: `runner-${Date.now()}@test.local`, passwordHash: 'x' },
    });
    monitor = await prisma.monitor.create({
      data: {
        userId: user.id,
        name: 'Test',
        url: 'https://example.com',
        intervalSec: 60,
      },
    });
    nextResult = up;
  });

  /** Runs one probe with a fixed outcome. */
  async function probeOnce(result: ProbeResult) {
    nextResult = result;
    return runner.runCheck(monitor);
  }

  const openIncidents = () =>
    prisma.incident.findMany({
      where: { monitorId: monitor.id, resolvedAt: null },
    });
  const allIncidents = () =>
    prisma.incident.findMany({
      where: { monitorId: monitor.id },
      orderBy: { startedAt: 'asc' },
    });

  describe('recording checks', () => {
    it('stores a successful probe', async () => {
      const check = await probeOnce(up);

      expect(check.ok).toBe(true);
      expect(check.statusCode).toBe(200);
      expect(check.responseMs).toBe(120);
      expect(check.error).toBeNull();
    });

    it('stores the reason a probe failed', async () => {
      const check = await probeOnce(timedOut);

      expect(check.ok).toBe(false);
      expect(check.statusCode).toBeNull();
      expect(check.error).toBe('No response within 2000ms');
    });

    it('stamps lastCheckedAt even when the probe failed', async () => {
      // Otherwise a down site would be re-probed on every sweep instead of on its
      // own interval.
      await probeOnce(down);

      const updated = await prisma.monitor.findUniqueOrThrow({
        where: { id: monitor.id },
      });
      expect(updated.lastCheckedAt).not.toBeNull();
    });
  });

  describe('opening an incident', () => {
    it('does not open one on a single failure', async () => {
      // A lone failure is noise: a dropped packet, or a deploy restarting.
      await probeOnce(down);

      expect(await allIncidents()).toEqual([]);
    });

    it('opens one on the second consecutive failure', async () => {
      await probeOnce(down);
      await probeOnce(down);

      const incidents = await openIncidents();
      expect(incidents.length).toBe(1);
      expect(incidents[0].cause).toBe('Expected 200, got 503');
    });

    it('does not open a second incident while one is already open', async () => {
      await probeOnce(down);
      await probeOnce(down);
      await probeOnce(down);
      await probeOnce(down);

      expect((await allIncidents()).length).toBe(1);
    });

    it('counts every failure against the open incident', async () => {
      await probeOnce(down);
      await probeOnce(down); // opens, recorded as 2
      await probeOnce(down); // 3
      await probeOnce(down); // 4

      const [incident] = await allIncidents();
      expect(incident.failureCount).toBe(4);
    });

    it('resets the streak on a success in between', async () => {
      // fail, recover, fail: never two in a row, so no outage.
      await probeOnce(down);
      await probeOnce(up);
      await probeOnce(down);

      expect(await allIncidents()).toEqual([]);
    });
  });

  describe('resolving an incident', () => {
    it('closes the open incident on the first success', async () => {
      await probeOnce(down);
      await probeOnce(down);
      await probeOnce(up);

      const [incident] = await allIncidents();
      expect(incident.resolvedAt).not.toBeNull();
      expect(await openIncidents()).toEqual([]);
    });

    it('recovers immediately rather than requiring a threshold', async () => {
      // Asymmetric on purpose: slow to declare an outage, quick to declare recovery.
      await probeOnce(down);
      await probeOnce(down);
      await probeOnce(up);

      expect(await openIncidents()).toEqual([]);
    });

    it('does nothing on a success when nothing was wrong', async () => {
      await probeOnce(up);
      await probeOnce(up);

      expect(await allIncidents()).toEqual([]);
    });

    it('opens a second incident when it goes down again later', async () => {
      await probeOnce(down);
      await probeOnce(down); // incident 1
      await probeOnce(up); // resolved
      await probeOnce(down);
      await probeOnce(down); // incident 2

      const incidents = await allIncidents();
      expect(incidents.length).toBe(2);
      expect(incidents[0].resolvedAt).not.toBeNull();
      expect(incidents[1].resolvedAt).toBeNull();
    });
  });

  describe('failure history', () => {
    it('does not open an incident from failures on another monitor', async () => {
      // The streak is per monitor; a shared counter would page you for the wrong site.
      const other = await prisma.monitor.create({
        data: {
          userId: monitor.userId,
          name: 'Other',
          url: 'https://other.example.com',
        },
      });

      nextResult = down;
      await runner.runCheck(other);
      await runner.runCheck(monitor);

      expect(await allIncidents()).toEqual([]);
      expect(
        await prisma.incident.findMany({ where: { monitorId: other.id } }),
      ).toEqual([]);
    });
  });
});
