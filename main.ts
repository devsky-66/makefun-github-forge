// Entry point: the harness lifecycle for this forge.
//
// The program is a server, not a script: it stays up for the whole trial.
// It binds an ephemeral port, tells the suite (the env) which port it picked,
// then waits until the suite says the trial is over. The suite drives the
// forge over HTTP from then on; this file only owns the handshake with it:
//
//   1. Read the suite's origin from MAKEFUN_ENV_URL. With no origin there is
//      nothing to register with, so the program fails fast with exit 1.
//   2. Start the forge (see app.ts) on port 0 and let the kernel choose.
//      Port 8080 is the suite's own and must never be bound here.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. The suite records the
//      address that request came from plus N and dials the forge there. The
//      first registration wins: a 409 means another entry already won, and
//      this process simply keeps waiting like any other.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}. The
//      suite answers at once ({"done": false} while it is still working), so
//      this is a poll, never a long-held request. A failed or slow poll is
//      retried with a short exponential backoff; the process never exits
//      before the suite says done.
//   5. Close the server and exit 0. The suite then writes the export the
//      scorer reads.
//
// Only the forge itself is imported here: no package, no model call.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One request may take this long before it is abandoned and retried.
const REQUEST_TIMEOUT_MS = 30_000;
// Retry waits start here and double, up to this cap.
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Wait after `attempt` failed requests: exponential from RETRY_FIRST_MS,
// capped at RETRY_CAP_MS (the exponent stops growing after 8 doublings).
function backoffMs(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer
 * and 409 means a first register already won, which is not this process's
 * to fix. 400 and 405 are contract errors and end the program; a network
 * error or any other status is retried, since the env may still be starting.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register answered HTTP ')) throw error;
    }
    await sleep(backoffMs(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done.
    }
    await sleep(backoffMs(attempt));
  }
}

/** Bind the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
