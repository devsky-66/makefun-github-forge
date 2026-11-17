# makefun-github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/devsky-66/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/devsky-66/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node 22 process: git smart HTTP (upload-pack protocol v2, receive-pack v0), the REST v3 API, GraphQL v4 and an MCP endpoint, all over its own in-memory store. No UI, no git binary, no outside service, no dependencies — only the Node standard library.

## Run it

```sh
MAKEFUN_ENV_URL=http://localhost:8080 npm start
```

The forge binds an ephemeral port, registers it with the suite at `$MAKEFUN_ENV_URL/register`, serves until the suite answers `{"done": true}` on `$MAKEFUN_ENV_URL/done`, then exits 0.

## What it serves

- **Git smart HTTP** — `/{owner}/{repo}.git`: `info/refs`, `git-upload-pack` (protocol v2 with `ls-refs`, v0 fallback) and `git-receive-pack` (v0, `report-status`, `side-band-64k`, `delete-refs`). Packfiles are built and parsed in-process (commit/tree/blob/tag objects, OFS/REF deltas, zlib); pushes are fast-forward only.
- **REST v3** — `/api/v3`: repositories, contents, labels, issues, pull requests and merges, with GitHub-style status codes, `X-GitHub-Request-Id`, pagination `Link` headers and bearer-token auth.
- **GraphQL v4** — `/api/graphql`: the documents `gh` and `github-mcp-server` send, including introspection for `Issue`, `PullRequest` and `Repository`, ordered/filtered issue queries and `createPullRequest`.
- **MCP** — `/mcp`: JSON-RPC 2.0 over Streamable HTTP (`initialize`, `tools/list`, `tools/call` with `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`), acting on the same store as REST.

## Layout

- `main.ts` — entry ↔ suite lifecycle (bind, register, wait for done). Kept as the kit ships it.
- `app.ts` — HTTP routing: dispatches git, REST, GraphQL and MCP onto one shared store.
- `store.ts` — the in-memory store: repositories, refs, issues, pull requests, labels.
- `objects.ts` — git object model: hashing, tree/commit encoding, delta application.
- `git.ts` — smart HTTP: pkt-line framing, packfile read/write, upload-pack v2/v0, receive-pack v0.
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — GraphQL lexer, parser and resolvers.
- `mcp.ts` — MCP (JSON-RPC 2.0 Streamable HTTP) handlers.

---

<sub>Entered on [make.fun](https://make.fun/?ref=a7w1hpae&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
