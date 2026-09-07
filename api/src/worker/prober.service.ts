import { Injectable, Logger } from '@nestjs/common';

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
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          // Identify the prober. Some sites block unknown agents outright, and an
          // honest UA is better manners than pretending to be a browser.
          'User-Agent':
            'Pulse-Uptime-Monitor/1.0 (+https://github.com/DYasser/pulse)',
          Accept: '*/*',
        },
      });

      // Drain the body so the socket can be reused and a huge page cannot be held
      // in memory. The content is irrelevant - only the status matters.
      await response.arrayBuffer().catch(() => undefined);

      const responseMs = Date.now() - startedAt;
      const ok = response.status === expectedStatus;

      return {
        ok,
        statusCode: response.status,
        responseMs,
        error: ok ? null : `Expected ${expectedStatus}, got ${response.status}`,
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
