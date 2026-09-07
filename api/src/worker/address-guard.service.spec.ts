import { AddressGuardService } from './address-guard.service';

/**
 * The SSRF guard.
 *
 * The addresses below are the ones that matter: class-validator's IsUrl with
 * require_tld accepts every one of them, which is why this exists. Cases use
 * literal addresses so they need no DNS and cannot flake.
 */
describe('AddressGuardService', () => {
  const guard = new AddressGuardService();

  describe('addresses that must be refused', () => {
    const blocked = [
      [
        'cloud metadata (AWS/GCP/Azure/Fly)',
        'http://169.254.169.254/latest/meta-data/',
      ],
      ['link-local, another host in the range', 'http://169.254.1.1/'],
      ['loopback', 'http://127.0.0.1/'],
      ['loopback, a database port', 'http://127.0.0.1:5432/'],
      ['loopback, elsewhere in 127/8', 'http://127.1.2.3/'],
      ['private 10/8', 'http://10.0.0.1/'],
      ['private 172.16/12', 'http://172.16.0.1/'],
      ['private 192.168/16', 'http://192.168.1.1/'],
      ['carrier-grade NAT', 'http://100.64.0.1/'],
      ['this-host', 'http://0.0.0.0/'],
      ['IPv6 loopback', 'http://[::1]/'],
      ['IPv6 link-local', 'http://[fe80::1]/'],
      ['IPv6 unique-local', 'http://[fc00::1]/'],
      ['IPv4-mapped IPv6 private', 'http://[::ffff:10.0.0.1]/'],
    ];

    for (const [description, url] of blocked) {
      it(`refuses ${description}`, async () => {
        const verdict = await guard.check(url);

        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toBeTruthy();
      });
    }
  });

  describe('addresses that should be allowed', () => {
    it('allows a public literal address', async () => {
      expect((await guard.check('http://1.1.1.1/')).allowed).toBe(true);
    });

    it('allows another public literal address', async () => {
      expect((await guard.check('http://8.8.8.8/')).allowed).toBe(true);
    });

    it('allows 172.32.x, just outside the private range', async () => {
      // 172.16/12 covers 172.16 - 172.31 only; an off-by-one here would block a
      // legitimate host.
      expect((await guard.check('http://172.32.0.1/')).allowed).toBe(true);
    });

    it('allows 11.x, just outside 10/8', async () => {
      expect((await guard.check('http://11.0.0.1/')).allowed).toBe(true);
    });

    it('allows 192.167.x, just outside 192.168/16', async () => {
      expect((await guard.check('http://192.167.1.1/')).allowed).toBe(true);
    });
  });

  describe('protocols', () => {
    it('refuses anything that is not http or https', async () => {
      expect((await guard.check('ftp://example.com/')).allowed).toBe(false);
      expect((await guard.check('file:///etc/passwd')).allowed).toBe(false);
      expect((await guard.check('gopher://example.com/')).allowed).toBe(false);
    });

    it('allows both http and https', async () => {
      expect((await guard.check('http://1.1.1.1/')).allowed).toBe(true);
      expect((await guard.check('https://1.1.1.1/')).allowed).toBe(true);
    });
  });

  describe('malformed input', () => {
    it('refuses a URL that cannot be parsed', async () => {
      expect((await guard.check('not a url')).allowed).toBe(false);
    });

    it('refuses an empty string', async () => {
      expect((await guard.check('')).allowed).toBe(false);
    });
  });

  describe('hostnames', () => {
    it('allows a name that does not resolve', async () => {
      // A dead name is a monitor that will report failures, not a security
      // problem - the user should see why rather than be told it is forbidden.
      expect((await guard.check('http://nonexistent.invalid/')).allowed).toBe(
        true,
      );
    });

    it('refuses a name that resolves into private space', async () => {
      // The reason DNS is resolved at all: a public hostname can point anywhere.
      // localhost resolves to 127.0.0.1 (and/or ::1), both of which are blocked.
      expect((await guard.check('http://localhost/')).allowed).toBe(false);
    });
  });

  describe('checkAddress, used per redirect hop', () => {
    it('judges a bare address without needing a URL', () => {
      expect(guard.checkAddress('169.254.169.254').allowed).toBe(false);
      expect(guard.checkAddress('1.1.1.1').allowed).toBe(true);
    });

    it('refuses something that is not an address at all', () => {
      expect(guard.checkAddress('not-an-address').allowed).toBe(false);
    });
  });
});
