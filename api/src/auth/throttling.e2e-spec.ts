import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'http';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';

/**
 * The rate limits, with throttling deliberately left on.
 *
 * The API suite disables it, so without this file a broken limit would pass CI
 * unnoticed - and the login limit is the only thing between a cost-12 bcrypt and
 * trivial CPU exhaustion.
 */
describe('Auth rate limiting', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.Agent;

  beforeAll(async () => {
    process.env.WORKER_ENABLED = 'false';
    delete process.env.THROTTLE_DISABLED;

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
      }),
    );
    // Same filter main.ts installs, so these cases exercise the real error
    // handling rather than Nest's default.
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    http = () => request(app.getHttpServer() as Server);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.truncateAll();
  });

  it('stops registration after the hourly allowance', async () => {
    const attempt = (n: number) =>
      http()
        .post('/api/auth/register')
        .send({
          email: `flood${n}@test.local`,
          password: 'a-sufficiently-long-password',
        });

    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      statuses.push((await attempt(i)).status);
    }

    // Five allowed, then 429 - not an endless stream of new accounts.
    expect(statuses.filter((s) => s === 201).length).toBe(5);
    expect(statuses).toContain(429);
  });

  it('stops login attempts before they become a CPU attack', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 13; i++) {
      const response = await http().post('/api/auth/login').send({
        email: 'nobody@test.local',
        password: 'a-sufficiently-long-password',
      });
      statuses.push(response.status);
    }

    // Ten 401s, then refusals. Every one of those 401s costs a full bcrypt by
    // design, which is exactly why the limit has to exist.
    expect(statuses.filter((s) => s === 401).length).toBe(10);
    expect(statuses.filter((s) => s === 429).length).toBe(3);
  });
});
