import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { ProberService } from './prober.service';
import { AddressGuardService } from './address-guard.service';

/**
 * The prober, against a real HTTP server on localhost.
 *
 * A stubbed fetch would only prove the stub was called. These cases run genuine
 * requests, so timeouts really time out and a refused connection is really refused -
 * which is the whole difficulty of probing arbitrary URLs.
 */
describe('ProberService', () => {
  let prober: ProberService;
  let server: Server;
  let baseUrl: string;

  /** Set per test to control what the server does. */
  let handler: (respond: (status: number, body?: string) => void) => void;

  beforeAll(async () => {
    // 127.0.0.1 is what these tests probe, so the guard is stubbed open here.
    // The guard's own rules are covered in address-guard.service.spec.ts.
    prober = new ProberService({
      check: () => Promise.resolve({ allowed: true }),
    } as unknown as AddressGuardService);

    server = createServer((_req, res) => {
      handler((status, body = 'ok') => {
        res.writeHead(status, { 'Content-Type': 'text/plain' });
        res.end(body);
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    handler = (respond) => respond(200);
  });

  describe('a healthy endpoint', () => {
    it('reports ok when the status matches', async () => {
      const result = await prober.probe(baseUrl, 200, 2000);

      expect(result.ok).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.error).toBeNull();
    });

    it('measures how long the response took', async () => {
      const result = await prober.probe(baseUrl, 200, 2000);

      expect(result.responseMs).toBeGreaterThanOrEqual(0);
      expect(result.responseMs).toBeLessThan(2000);
    });

    it('honours a non-200 expected status', async () => {
      // A 301 endpoint is up when it returns 301, not when it returns 200.
      handler = (respond) => respond(204);

      expect((await prober.probe(baseUrl, 204, 2000)).ok).toBe(true);
      expect((await prober.probe(baseUrl, 200, 2000)).ok).toBe(false);
    });
  });

  describe('an unhealthy endpoint', () => {
    it('fails on an unexpected status and says what it got', async () => {
      handler = (respond) => respond(503);

      const result = await prober.probe(baseUrl, 200, 2000);

      expect(result.ok).toBe(false);
      expect(result.statusCode).toBe(503);
      expect(result.error).toBe('Expected 200, got 503');
    });

    it('records the status even on failure, so the row explains itself', async () => {
      handler = (respond) => respond(500);

      expect((await prober.probe(baseUrl, 200, 2000)).statusCode).toBe(500);
    });
  });

  describe('failures with no response', () => {
    it('times out a server that never replies', async () => {
      handler = () => {
        /* hang deliberately */
      };

      const result = await prober.probe(baseUrl, 200, 300);

      expect(result.ok).toBe(false);
      expect(result.statusCode).toBeNull();
      expect(result.error).toBe('No response within 300ms');
    });

    it('reports a refused connection rather than throwing', async () => {
      // Port 1 is reserved and nothing listens on it.
      const result = await prober.probe('http://127.0.0.1:1', 200, 2000);

      expect(result.ok).toBe(false);
      expect(result.statusCode).toBeNull();
      expect(result.error).toBeTruthy();
    });

    it('reports an unresolvable hostname', async () => {
      const result = await prober.probe(
        'http://nonexistent.invalid',
        200,
        3000,
      );

      expect(result.ok).toBe(false);
      expect(result.statusCode).toBeNull();
      expect(result.error).toBeTruthy();
    });

    it('never throws, whatever the URL', async () => {
      // "The site is down" is a normal outcome here, not an exception - the caller
      // must always get a row to record.
      await expect(
        prober.probe('http://127.0.0.1:1', 200, 500),
      ).resolves.toBeDefined();
      await expect(
        prober.probe('http://nonexistent.invalid', 200, 500),
      ).resolves.toBeDefined();
    });
  });
});
