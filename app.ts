// The forge's HTTP server: one in-memory Store shared by all four surfaces.
// main.ts is the entry <-> env lifecycle and stays as it is; this file wires the
// handlers the three implementation groups delivered:
//   git.ts       smart HTTP (upload-pack v2 / receive-pack v0)
//   rest.ts      REST v3 under /api/v3
//   graphql.ts   GraphQL v4 at /api/graphql
//   mcp.ts       MCP (JSON-RPC 2.0 streamable HTTP) at /mcp
// A handler returns true when it owned the request (and ended the response),
// false when the path is not its own. Anything unclaimed is GitHub's 404 body.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './git.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (await handleGit(req, res, store)) return;
        if (await handleRest(req, res, store)) return;
        if (await handleGraphql(req, res, store)) return;
        if (await handleMcp(req, res, store)) return;

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A handler must never take the server down: answer 500 once, if still possible.
        try {
          if (!res.writableEnded) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          // The socket is already gone; nothing left to do.
        }
      }
    })();
  });
}
