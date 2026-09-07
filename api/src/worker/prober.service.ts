import { Injectable, Logger } from '@nestjs/common';
import { AddressGuardService } from './address-guard.service';

/** The outcome of a single probe. */
export interface ProbeResult {
  ok: boolean;
  /** Null when no response arrived at all - DNS failure, timeout, refused. */
  statusCode: number | null;
  responseMs: number | null;
  error: string | null;
}

/**
 * Performs one HTTP probe.
 *
 * Deliberately narrow: no retries, no queueing, no database. It answers "what
 * happened when I asked this URL right now", which makes it trivial to test and
 * keeps the retry policy in one place (CheckRunner) rather than two.
 */
@Injectable()
export class ProberService {
  private readonly logger = new Logger(ProberService.name);

  /**
   * Redirects are followed by hand so every hop can be re-checked against the
   * address guard. `redirect: 'follow'` would let a public URL bounce the probe
   * into private space - the classic SSRF bypass, since validating the submitted
   * URL says nothing about where it points next.
   */
  private readonly MAX_REDIRECTS = 5;

  /**
   * The body is drained so the socket can be reused, but only this much of it.
   * Reading an unbounded response into memory is a denial of service against a
   * 512MB machine, and the content is irrelevant here - only the status matters.
   */
  private readonly MAX_BODY_BYTES = 64 * 1024;

  constructor(private readonly addressGuard: AddressGuardService) {}

  /**
   * A probe never throws. Every failure mode - timeout, DNS, TLS, refused
   * connection, unexpected status - comes back as a result with ok: false, because
   * "the site is down" is a normal outcome for this service, not an exception.
   */
  async probe(
    url: string,
    expectedStatus: number,
    timeoutMs: number,
  ): Promise<ProbeResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchFollowingRedirects(
        url,
        controller.signal,
      );

      if ('refused' in response) {
        return {
          ok: false,
          statusCode: null,
          responseMs: Date.now() - startedAt,
          error: response.refused,
        };
      }

      await this.drain(response.value);

      // Checked after the drain, not before. A site can answer with headers
      // promptly and then hang mid-body - a real degradation for a page that
      // flushes headers before querying a database. The status line says 200, so
      // without this the probe would report the site as up and the measured
      // latency would silently be the timeout value rather than a response time.
      if (controller.signal.aborted) {
        return {
          ok: false,
          statusCode: response.value.status,
          responseMs: Date.now() - startedAt,
          error: `Response body did not complete within ${timeoutMs}ms`,
        };
      }

      const responseMs = Date.now() - startedAt;
      const ok = response.value.status === expectedStatus;
      const status = response.value.status;

      return {
        ok,
        statusCode: status,
        responseMs,
        error: ok ? null : `Expected ${expectedStatus}, got ${status}`,
      };
    } catch (error) {
      const responseMs = Date.now() - startedAt;
      return {
        ok: false,
        statusCode: null,
        responseMs,
        // The signal is the reliable signal, so to speak: an aborted fetch surfaces
        // differently depending on how far the request got.
        error: this.describe(error, timeoutMs, controller.signal.aborted),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetches, re-checking the address guard at every hop.
   *
   * Returns either the final response or the reason the probe was refused. A
   * refusal is not an error: a monitor pointed somewhere it may not go should
   * report that as a failed check, the same as a site being down.
   */
  private async fetchFollowingRedirects(
    url: string,
    signal: AbortSignal,
  ): Promise<{ value: Response } | { refused: string }> {
    let current = url;

    for (let hop = 0; hop <= this.MAX_REDIRECTS; hop++) {
      const verdict = await this.addressGuard.check(current);
      if (!verdict.allowed) {
        return {
          refused:
            hop === 0
              ? (verdict.reason ?? 'Address is not allowed')
              : `Redirected to an address that is not publicly routable`,
        };
      }

      const response = await fetch(current, {
        method: 'GET',
        signal,
        // Manual, so each Location can be guarded before it is followed.
        redirect: 'manual',
        headers: {
          // Identify the prober. Some sites block unknown agents outright, and an
          // honest UA is better manners than pretending to be a browser.
          'User-Agent':
            'Pulse-Uptime-Monitor/1.0 (+https://github.com/DYasser/pulse)',
          Accept: '*/*',
        },
      });

      const location = response.headers.get('location');
      const isRedirect = response.status >= 300 && response.status < 400;

      if (!isRedirect || !location) {
        return { value: response };
      }

      // Don't leave the body of an intermediate response unread.
      await this.drain(response);

      try {
        current = new URL(location, current).toString();
      } catch {
        return { refused: 'Redirected to a URL that could not be parsed' };
      }
    }

    return { refused: `More than ${this.MAX_REDIRECTS} redirects` };
  }

  /**
   * Reads and discards up to MAX_BODY_BYTES so the connection can be reused,
   * then cancels the rest. Reading it all would let a large response exhaust
   * memory, and nothing here needs the content.
   */
  private async drain(response: Response): Promise<void> {
    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    let read = 0;

    try {
      while (read < this.MAX_BODY_BYTES) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        read += value.byteLength;
      }
      await reader.cancel();
    } catch {
      // A truncated or reset body does not change the verdict - the status is
      // what matters, and it has already been read.
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Turns a thrown value into something a user can act on. Node's fetch errors are
   * unhelpful by default: an aborted request and a DNS failure both surface as a
   * bare "fetch failed".
   */
  private describe(
    error: unknown,
    timeoutMs: number,
    aborted: boolean,
  ): string {
    // Checked first, and from the signal rather than the error: an abort surfaces as
    // AbortError when the connection was open but as a bare TypeError("fetch failed")
    // when it was still connecting, so the error shape alone cannot be trusted.
    if (aborted) {
      return `No response within ${timeoutMs}ms`;
    }

    if (error instanceof Error) {
      // The useful detail is usually on the cause, not the top-level error.
      const cause = (error as { cause?: { code?: string; message?: string } })
        .cause;
      switch (cause?.code) {
        case 'ENOTFOUND':
          return 'Hostname could not be resolved';
        case 'ECONNREFUSED':
          return 'Connection refused';
        case 'ECONNRESET':
          return 'Connection reset';
        case 'ETIMEDOUT':
          return 'Connection timed out';
        case 'CERT_HAS_EXPIRED':
          return 'TLS certificate has expired';
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
          return 'TLS certificate could not be verified';
      }

      if (cause?.message) {
        return cause.message;
      }
      return error.message;
    }

    this.logger.warn(`Non-error thrown during probe: ${String(error)}`);
    return 'Unknown failure';
  }
}
