# Pulse

An uptime monitor. You register URLs; a background worker probes them on their own
schedules, records every result, and turns streaks of failures into incidents you can
read as periods of downtime rather than a pile of events.

[![CI](https://github.com/DYasser/pulse/actions/workflows/ci.yml/badge.svg)](https://github.com/DYasser/pulse/actions/workflows/ci.yml)

NestJS · TypeScript · PostgreSQL · Prisma · Docker

---

## Why this exists

A monitor cannot be a front-end. Something has to be awake at 3am probing your URLs
while your laptop is closed, which rules out the browser, static hosting, and
anything that only runs while someone is looking at it. The server is the premise,
not a design choice — that is exactly why I built this one.

The interesting problems are all on that side: deciding what is due without
recomputing history, probing arbitrary URLs that time out and lie and hang, and
deriving "this has been down for 20 minutes" from a stream of individual checks.

## The data model

Four tables. Three are unremarkable; the fourth is the point.

```
users ──< monitors ──< checks
                   └──< incidents
```

- **`monitors`** — a URL, how often to probe it, what status counts as healthy, and
  `last_checked_at` so the scheduler can find stale ones with an index rather than a
  scan.
- **`checks`** — one row per probe. Status code, response time, and on failure the
  reason, so a red row explains itself.
- **`incidents`** — a period of downtime. Nobody wants to read 288 daily check rows
  to learn a site went down at 14:32, so consecutive failures are collapsed into an
  incident with a start, an end, and a cause.

Indexes follow the queries rather than the columns: `(paused, last_checked_at)` for
the scheduler's hot path, `(monitor_id, checked_at)` for history, and
`(monitor_id, resolved_at)` for finding a monitor's open incident.

## The interesting part: turning failures into incidents

**One failure is not an outage.** A dropped packet or a deploy restarting would
otherwise page you at 3am. An incident opens only after `FAILURE_THRESHOLD`
consecutive failures — two by default, the smallest number that filters transient
noise while still catching a real outage within one interval.

**Recovery is asymmetric, on purpose.** A single success closes the incident
immediately. Being slow to declare an outage avoids false alarms; being slow to
declare recovery just means lying about the current state.

**The streak is read from history, not held in a counter.** A `consecutive_failures`
column would drift out of sync with the checks a user can actually read. Counting the
last N rows cannot.

## Probing hostile URLs

The prober does one thing: ask a URL what it says, right now. No retries, no queue,
no database — so the retry policy lives in one place and this stays testable.

It never throws. "The site is down" is a normal outcome for this service, not an
exception, so every failure mode comes back as a result the caller can record.

Node's `fetch` errors are unhelpful by default — a DNS failure and an aborted request
both surface as `TypeError: fetch failed` — so failures are translated into something
a person can act on: *Hostname could not be resolved*, *Connection refused*, *TLS
certificate has expired*, *No response within 10000ms*.

One subtlety worth the comment it carries in the source: a timeout is detected from
`AbortSignal.aborted`, not from the error. An aborted fetch surfaces as `AbortError`
when the connection was open but as a bare `TypeError` when it was still connecting,
so the error shape alone cannot be trusted. A test against a deliberately hanging
server caught that.

## Scheduling

One cron tick a minute; each monitor's own interval decides whether it is due. A
timer per monitor would have to be rebuilt whenever a monitor changed.

- **Due-ness is computed in SQL**, because `last_checked_at + interval_sec` is a
  per-row comparison the query builder cannot express.
- **Probes run in batches of ten.** Each is mostly idle waiting on the network, so
  this is not about CPU — it bounds open sockets and database connections. Five
  hundred at once would exhaust the connection pool long before the event loop.
- **A slow sweep skips the next tick** rather than running twice and double-probing.
- **`allSettled`, not `all`** — one monitor throwing unexpectedly must not abandon
  the rest of the batch.
- **`WORKER_ENABLED=false`** runs the same image as an API-only process, so scaling
  the API to two instances does not probe everything twice.

## Two bugs worth showing

Both were found by running the thing rather than by reading it.

**`No response within undefinedms`.** The due-ness query is raw SQL, and Prisma's
`$queryRaw` bypasses the `@map` translation in the schema — it returns raw
`snake_case` columns. Casting that to `Monitor[]` type-checked perfectly while
leaving every camelCase field `undefined` at runtime, so the prober was called with
`timeoutMs: undefined` and every probe aborted instantly. The query now selects ids
and re-reads through the client, so there is one mapping path instead of two. A
regression test asserts the scheduler hands over fully populated monitors, and fails
against the original implementation.

**Timeouts reported as "Unknown failure".** Covered above: the fix was to read the
signal rather than pattern-match the error.

Neither would have been caught by a unit test with a mocked database or a stubbed
`fetch`. That is why the suite has neither.

## Testing

90 tests. No mocked database and no stubbed HTTP:

- **`check-runner.service.spec.ts`** — incident derivation against real Postgres.
  The prober is the one thing stubbed, because the cases are about what a *sequence*
  of results does to the incidents table.
- **`prober.service.spec.ts`** — real HTTP against a server on localhost, so
  timeouts really time out and refused connections are really refused.
- **`scheduler.service.spec.ts`** — which monitors a sweep picks up, including the
  interval arithmetic, which only means anything against a real database.
- **`monitors.e2e-spec.ts`** — the API over HTTP through the real pipeline:
  validation, guards, serialisation. This is where a missing guard shows up, and
  where the SSRF rejections are asserted end to end.
- **`address-guard.service.spec.ts`** — every address range that must be refused,
  including the ones `IsUrl` waves through.
- **`throttling.e2e-spec.ts`** — the rate limits, with throttling deliberately
  left on, because the API suite turns it off and a broken limit would otherwise
  pass CI unnoticed.

The suite runs against a separate `pulse_test` database so a test run cannot truncate
data you were looking at.

## Security choices

Small things, all deliberate:

- **bcrypt at cost 12**, and the password is capped at 72 bytes because bcrypt
  silently ignores anything beyond that — an uncapped field makes long passwords
  weaker than they look.
- **Login compares against a dummy hash when the user does not exist**, so the
  response time cannot be used to enumerate accounts.
- **Another user's monitor returns 404, not 403.** A 403 confirms the id exists.
- **The JWT is not trusted for identity.** The user is re-read on every request, so a
  deleted account stops working immediately rather than at token expiry.
- **Unknown request fields are rejected**, not ignored — otherwise a client could
  send `userId` and create a monitor belonging to somebody else. There is a test for
  exactly that.
- **URLs are checked against the resolved address, not the hostname.** The server
  fetches whatever it is given, which makes this an SSRF vector unless something
  stops it reaching private space - and `class-validator`'s `IsUrl` with
  `require_tld` does **not**: it rejects `http://localhost/` but happily accepts
  `http://169.254.169.254/` (cloud metadata), `http://10.0.0.1/` and
  `http://127.0.0.1:5432/`. `AddressGuardService` resolves the hostname and refuses
  loopback, link-local, the private ranges, CGNAT, IPv6 loopback/link-local/ULA,
  and both spellings of IPv4-mapped IPv6 - the WHATWG URL parser rewrites
  `::ffff:10.0.0.1` as `::ffff:a00:1`, so matching only the dotted form misses it.
- **Redirects are followed by hand, re-checking every hop.** `redirect: 'follow'`
  lets a fully public URL bounce the probe into private space, which bypasses any
  amount of create-time validation. The check also runs again at probe time, not
  just at creation, because DNS can be repointed afterwards.
- **The response body is capped at 64KB.** `arrayBuffer()` buffers the *entire*
  body before resolving, so a large response is a denial of service against a
  512MB machine - ten concurrent probes at a few hundred MB each. The status is all
  this needs, so the stream is read to the cap and cancelled.
- **Rate limits on auth.** Login costs a deliberate cost-12 bcrypt even for an
  address that does not exist, which makes the timing-equalisation that prevents
  enumeration into a CPU amplifier. Ten logins a minute, five registrations an
  hour, and fifty monitors per account.
- **A partial unique index enforces one open incident per monitor.** The worker's
  check-then-insert is not transactional, so two processes could each open one and
  the resolver would close only the first, leaving a monitor down forever.

## Running it

```bash
docker compose up -d db          # Postgres on :5433
cd api
cp .env.example .env             # then set JWT_SECRET
npm ci
npx prisma migrate dev
npm run start:dev                # http://localhost:3000/api
```

```bash
npm run lint
npm test                         # 90 tests, needs the database up
npm run build
docker build -t pulse-api ./     # same image CI builds
```

Migrations run on container start via `prisma migrate deploy`, which only applies
committed migrations — it never generates or resets, so it is safe on every boot.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/register` | Create an account, receive a token |
| `POST` | `/api/auth/login` | Exchange credentials for a token |
| `GET` | `/api/auth/me` | Confirm a stored token is still valid |
| `GET` | `/api/monitors` | List your monitors |
| `POST` | `/api/monitors` | Register a URL to watch |
| `GET` | `/api/monitors/summary` | Dashboard view: status, latency, 24h uptime |
| `GET` | `/api/monitors/:id` | One monitor |
| `PATCH` | `/api/monitors/:id` | Update; send only what changes |
| `DELETE` | `/api/monitors/:id` | Remove it and its history |
| `GET` | `/api/monitors/:id/checks` | Recent probe results |
| `GET` | `/api/monitors/:id/incidents` | Downtime periods |
| `GET` | `/api/health` | Readiness, including the database |

`/api/monitors/summary` is one endpoint doing three queries rather than N+1 per
monitor, because the dashboard reloads often. A never-probed monitor reports
`pending` with `uptime24h: null` — an unmeasured monitor is not a perfect one.

## Known gaps

Stated rather than hidden:

- **No alerting yet.** Incidents are recorded and served, but nothing emails or pages
  you. That is the next piece of real work, and it needs a provider and a
  deduplication story rather than just an SMTP call.
- **No front end yet.** The API and worker are the point of this repo; a thin
  dashboard is planned, deliberately thin.
- **The scheduler assumes one worker.** `WORKER_ENABLED=false` on extra instances
  is a deploy-time convention, not enforcement: two machines with the worker on
  would both probe. The partial unique index prevents the worst outcome
  (duplicate open incidents), but the honest fix is claiming due monitors with
  `SELECT ... FOR UPDATE SKIP LOCKED` rather than select-then-stamp.
- **DNS rebinding is only mitigated, not solved.** The address guard resolves and
  checks at create time and again at probe time, but a name with a one-second TTL
  can still change between the check and the connection. Closing that properly
  needs a custom undici agent validating the address at connect time.
