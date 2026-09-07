import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'http';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The API over HTTP, against a real database.
 *
 * These go through the actual request pipeline - validation, guards, serialisation -
 * because that is where the interesting failures live. A service-level test would
 * not catch a missing guard or a DTO that lets a client set someone else's userId.
 */
describe('Monitors API', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.Agent;

  beforeAll(async () => {
    // The scheduler would probe real URLs mid-test; disabled via the same switch
    // production uses to run API-only instances.
    process.env.WORKER_ENABLED = 'false';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();

    prisma = moduleRef.get(PrismaService);
    // getHttpServer() is typed `any`; narrowing it here keeps the assertions typed.
    http = () => request(app.getHttpServer() as Server);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.truncateAll();
  });

  // supertest types every response body as `any`, so these shapes are declared
  // once here and the helpers below hand back typed values.
  interface AuthBody {
    accessToken: string;
    user: { id: string; email: string };
  }
  interface MonitorBody {
    id: string;
    name: string;
    url: string;
    intervalSec: number;
    expectedStatus: number;
    paused: boolean;
    lastCheckedAt: string | null;
  }
  interface SummaryBody extends MonitorBody {
    status: 'up' | 'down' | 'paused' | 'pending';
    lastResponseMs: number | null;
    uptime24h: number | null;
    openIncidentSince: string | null;
  }

  /** Registers a user and returns a bearer token for them. */
  async function registerUser(email = 'owner@test.local'): Promise<string> {
    const response = await http()
      .post('/api/auth/register')
      .send({ email, password: 'a-sufficiently-long-password' })
      .expect(201);
    return (response.body as AuthBody).accessToken;
  }

  async function createMonitor(
    token: string,
    overrides: Record<string, unknown> = {},
  ): Promise<MonitorBody> {
    const response = await http()
      .post('/api/monitors')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Example', url: 'https://example.com', ...overrides })
      .expect(201);
    return response.body as MonitorBody;
  }

  /** GETs a summary and returns it typed. */
  async function fetchSummary(token: string): Promise<SummaryBody[]> {
    const response = await http()
      .get('/api/monitors/summary')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as SummaryBody[];
  }

  describe('authentication', () => {
    it('registers a user and returns a usable token', async () => {
      const token = await registerUser();

      await http()
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });

    it('stores a hash, never the password itself', async () => {
      await registerUser();

      const user = await prisma.user.findFirstOrThrow();
      expect(user.passwordHash).not.toContain('a-sufficiently-long-password');
      expect(user.passwordHash.startsWith('$2')).toBe(true); // bcrypt
    });

    it('lowercases the email so signups cannot be duplicated by case', async () => {
      await http()
        .post('/api/auth/register')
        .send({
          email: 'Mixed@Test.Local',
          password: 'a-sufficiently-long-password',
        })
        .expect(201);

      await http()
        .post('/api/auth/register')
        .send({
          email: 'mixed@test.local',
          password: 'a-sufficiently-long-password',
        })
        .expect(409);
    });

    it('rejects a short password', async () => {
      await http()
        .post('/api/auth/register')
        .send({ email: 'short@test.local', password: 'tooshort' })
        .expect(400);
    });

    it('rejects a malformed email', async () => {
      await http()
        .post('/api/auth/register')
        .send({
          email: 'not-an-email',
          password: 'a-sufficiently-long-password',
        })
        .expect(400);
    });

    it('logs in with the right password and rejects the wrong one', async () => {
      await registerUser('login@test.local');

      await http()
        .post('/api/auth/login')
        .send({
          email: 'login@test.local',
          password: 'a-sufficiently-long-password',
        })
        .expect(200);

      await http()
        .post('/api/auth/login')
        .send({ email: 'login@test.local', password: 'wrong-but-long-enough' })
        .expect(401);
    });

    it('gives the same status for an unknown email as for a wrong password', async () => {
      // Otherwise the response tells an attacker which addresses are registered.
      await http()
        .post('/api/auth/login')
        .send({
          email: 'nobody@test.local',
          password: 'a-sufficiently-long-password',
        })
        .expect(401);
    });
  });

  describe('authorisation', () => {
    it('refuses every monitor route without a token', async () => {
      await http().get('/api/monitors').expect(401);
      await http()
        .post('/api/monitors')
        .send({ name: 'x', url: 'https://x.com' })
        .expect(401);
      await http().get('/api/monitors/summary').expect(401);
    });

    it('refuses a token that is not a real token', async () => {
      await http()
        .get('/api/monitors')
        .set('Authorization', 'Bearer not-a-jwt')
        .expect(401);
    });

    it("hides another user's monitor behind a 404", async () => {
      // 404 rather than 403: a 403 would confirm the id exists.
      const owner = await registerUser('owner@test.local');
      const monitor = await createMonitor(owner);
      const stranger = await registerUser('stranger@test.local');

      await http()
        .get(`/api/monitors/${monitor.id}`)
        .set('Authorization', `Bearer ${stranger}`)
        .expect(404);
    });

    it("will not let one user delete another's monitor", async () => {
      const owner = await registerUser('owner@test.local');
      const monitor = await createMonitor(owner);
      const stranger = await registerUser('stranger@test.local');

      await http()
        .delete(`/api/monitors/${monitor.id}`)
        .set('Authorization', `Bearer ${stranger}`)
        .expect(404);

      expect(await prisma.monitor.count()).toBe(1);
    });

    it("lists only the caller's own monitors", async () => {
      const first = await registerUser('first@test.local');
      await createMonitor(first, { name: 'Mine' });
      const second = await registerUser('second@test.local');
      await createMonitor(second, { name: 'Theirs' });

      const response = await http()
        .get('/api/monitors')
        .set('Authorization', `Bearer ${first}`)
        .expect(200);

      const monitors = response.body as MonitorBody[];
      expect(monitors.map((m) => m.name)).toEqual(['Mine']);
    });
  });

  describe('validation', () => {
    it('rejects a URL that is not http(s)', async () => {
      const token = await registerUser();

      await http()
        .post('/api/monitors')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'FTP', url: 'ftp://example.com' })
        .expect(400);
    });

    it('rejects an interval below the one-minute floor', async () => {
      const token = await registerUser();

      await http()
        .post('/api/monitors')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Fast', url: 'https://example.com', intervalSec: 5 })
        .expect(400);
    });

    it('strips unknown fields rather than trusting them', async () => {
      // Without whitelisting, a client could set userId and create a monitor
      // belonging to somebody else.
      const token = await registerUser();

      await http()
        .post('/api/monitors')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Sneaky',
          url: 'https://example.com',
          userId: 'some-other-user',
        })
        .expect(400);
    });

    it('rejects an id that is not a uuid', async () => {
      const token = await registerUser();

      await http()
        .get('/api/monitors/not-a-uuid')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });
  });

  describe('monitor lifecycle', () => {
    it('applies sensible defaults on creation', async () => {
      const token = await registerUser();
      const monitor = await createMonitor(token);

      expect(monitor.intervalSec).toBe(300);
      expect(monitor.expectedStatus).toBe(200);
      expect(monitor.paused).toBe(false);
      expect(monitor.lastCheckedAt).toBeNull();
    });

    it('updates only the fields sent', async () => {
      const token = await registerUser();
      const monitor = await createMonitor(token, { name: 'Before' });

      const response = await http()
        .patch(`/api/monitors/${monitor.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ paused: true })
        .expect(200);

      const updated = response.body as MonitorBody;
      expect(updated.paused).toBe(true);
      expect(updated.name).toBe('Before');
    });

    it('deletes a monitor and its history with it', async () => {
      const token = await registerUser();
      const monitor = await createMonitor(token);
      await prisma.check.create({
        data: {
          monitorId: monitor.id,
          ok: true,
          statusCode: 200,
          responseMs: 10,
        },
      });

      await http()
        .delete(`/api/monitors/${monitor.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      expect(await prisma.check.count()).toBe(0);
    });
  });

  describe('dashboard summary', () => {
    it('reports a never-probed monitor as pending, not as up', async () => {
      const token = await registerUser();
      await createMonitor(token);

      const summary = await fetchSummary(token);

      expect(summary[0].status).toBe('pending');
      expect(summary[0].uptime24h).toBeNull();
    });

    it('reports status from the most recent check', async () => {
      const token = await registerUser();
      const monitor = await createMonitor(token);

      await prisma.check.create({
        data: {
          monitorId: monitor.id,
          ok: false,
          statusCode: 500,
          responseMs: 30,
          checkedAt: new Date(Date.now() - 60_000),
        },
      });
      await prisma.check.create({
        data: {
          monitorId: monitor.id,
          ok: true,
          statusCode: 200,
          responseMs: 42,
        },
      });

      const summary = await fetchSummary(token);

      expect(summary[0].status).toBe('up');
      expect(summary[0].lastResponseMs).toBe(42);
    });

    it('computes 24-hour uptime from the checks in that window', async () => {
      const token = await registerUser();
      const monitor = await createMonitor(token);

      // Three of four succeeded inside the window.
      for (const ok of [true, true, true, false]) {
        await prisma.check.create({
          data: {
            monitorId: monitor.id,
            ok,
            statusCode: ok ? 200 : 500,
            responseMs: 10,
          },
        });
      }
      // Outside the window, so it must not count.
      await prisma.check.create({
        data: {
          monitorId: monitor.id,
          ok: false,
          statusCode: 500,
          responseMs: 10,
          checkedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        },
      });

      const summary = await fetchSummary(token);

      expect(summary[0].uptime24h).toBe(75);
    });

    it('reports a paused monitor as paused whatever its last check said', async () => {
      const token = await registerUser();
      const monitor = await createMonitor(token, { paused: true });
      await prisma.check.create({
        data: {
          monitorId: monitor.id,
          ok: false,
          statusCode: 500,
          responseMs: 10,
        },
      });

      const summary = await fetchSummary(token);

      expect(summary[0].status).toBe('paused');
    });

    it('surfaces when an open incident began', async () => {
      const token = await registerUser();
      const monitor = await createMonitor(token);
      const startedAt = new Date(Date.now() - 30 * 60 * 1000);
      await prisma.incident.create({
        data: { monitorId: monitor.id, startedAt, cause: 'Connection refused' },
      });

      const summary = await fetchSummary(token);

      expect(new Date(summary[0].openIncidentSince!).getTime()).toBe(
        startedAt.getTime(),
      );
    });

    it('returns an empty list rather than failing when there is nothing yet', async () => {
      const token = await registerUser();

      const summary = await fetchSummary(token);

      expect(summary).toEqual([]);
    });
  });
});
