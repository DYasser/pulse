import { Injectable } from '@nestjs/common';
import { lookup } from 'dns/promises';
import { isIP } from 'net';

export interface AddressVerdict {
  allowed: boolean;
  /** Why it was refused, suitable for showing to the user. */
  reason?: string;
}

/**
 * Decides whether the prober is allowed to fetch a URL.
 *
 * The server fetches whatever it is told to, which makes this service an SSRF
 * vector unless something stops it reaching private space. `class-validator`'s
 * IsUrl with require_tld does not: it rejects `http://localhost/` but accepts
 * `http://169.254.169.254/` (cloud metadata), `http://10.0.0.1/` and
 * `http://127.0.0.1:5432/` without complaint.
 *
 * So the check happens here instead, on the resolved address rather than the
 * hostname - a public name can resolve to a private address, and a public URL can
 * redirect to one.
 */
@Injectable()
export class AddressGuardService {
  /**
   * Blocked CIDR ranges, as [network, prefix length] over the address's integer
   * form. Loopback, link-local (which is where every cloud metadata endpoint
   * lives), the three private ranges, carrier-grade NAT, and the reserved blocks.
   */
  private readonly BLOCKED_V4: [string, number][] = [
    ['0.0.0.0', 8], // "this host"
    ['10.0.0.0', 8], // private
    ['100.64.0.0', 10], // carrier-grade NAT
    ['127.0.0.0', 8], // loopback
    ['169.254.0.0', 16], // link-local - AWS/GCP/Azure/Fly metadata
    ['172.16.0.0', 12], // private
    ['192.0.0.0', 24], // IETF protocol assignments
    ['192.168.0.0', 16], // private
    ['198.18.0.0', 15], // benchmarking
    ['224.0.0.0', 4], // multicast
    ['240.0.0.0', 4], // reserved
  ];

  /**
   * Resolves the hostname and refuses if any address it answers with is private.
   *
   * Every address is checked, not just the first: a name that returns one public
   * and one private address must not be allowed through on a lucky ordering.
   */
  async check(rawUrl: string): Promise<AddressVerdict> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { allowed: false, reason: 'URL could not be parsed' };
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return {
        allowed: false,
        reason: 'Only http and https URLs can be monitored',
      };
    }

    const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

    // A literal address needs no DNS lookup.
    if (isIP(host)) {
      return this.checkAddress(host);
    }

    let addresses: { address: string }[];
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      // A name that does not resolve is not a security problem - it is just a
      // monitor that will report failures. Let it through so the user sees why.
      return { allowed: true };
    }

    for (const { address } of addresses) {
      const verdict = this.checkAddress(address);
      if (!verdict.allowed) {
        return verdict;
      }
    }

    return { allowed: true };
  }

  /** Whether one resolved address is outside private space. */
  checkAddress(address: string): AddressVerdict {
    const version = isIP(address);

    if (version === 4) {
      const value = this.toInt(address);
      for (const [network, prefix] of this.BLOCKED_V4) {
        const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
        if ((value & mask) === (this.toInt(network) & mask)) {
          return {
            allowed: false,
            reason: 'That address is not publicly routable',
          };
        }
      }
      return { allowed: true };
    }

    if (version === 6) {
      const normalised = address.toLowerCase();

      // ::1 loopback, :: unspecified, fe80::/10 link-local, fc00::/7 unique-local.
      if (
        normalised === '::1' ||
        normalised === '::' ||
        /^fe[89ab]/.test(normalised) ||
        /^f[cd]/.test(normalised)
      ) {
        return {
          allowed: false,
          reason: 'That address is not publicly routable',
        };
      }

      // IPv4-mapped addresses must be judged by the v4 rules or they bypass them.
      // Both spellings have to be handled: WHATWG URL parsing rewrites
      // ::ffff:10.0.0.1 into its hex form ::ffff:a00:1, so matching only the
      // dotted-quad form would miss every mapped address that arrives via a URL.
      const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalised);
      if (dotted) {
        return this.checkAddress(dotted[1]);
      }

      const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalised);
      if (hex) {
        const high = parseInt(hex[1], 16);
        const low = parseInt(hex[2], 16);
        const v4 = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
        return this.checkAddress(v4);
      }

      return { allowed: true };
    }

    return { allowed: false, reason: 'Address could not be understood' };
  }

  private toInt(address: string): number {
    return (
      address
        .split('.')
        .reduce((total, octet) => (total << 8) + Number(octet), 0) >>> 0
    );
  }
}
