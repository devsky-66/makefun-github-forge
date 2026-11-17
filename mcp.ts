// MCP endpoint (/mcp) handler for github-core-clone-01.
// Hand-written JSON-RPC 2.0 over Streamable HTTP: no npm packages, stdlib only.
// Reads checks-mcp.ts / mcp-client.ts as the contract:
//   modern 2026-07-28 server/discover + legacy initialize handshake,
//   tools/list (byte-stable), tools/call for the six github-mcp-server tools,
//   JSON-RPC -32700 parse error on HTTP 400, -32601/-32602 for unknown tools
//   and bad params, 401 without a Bearer token.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store, Repo, Issue, Pull } from './store.ts';
import { repoJson, issueJson, pullJson } from './store.ts';

export function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  return handleMcpInner(req, res, store);
}

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}
function tool(name: string, description: string, properties: Record<string, { type: string; description: string }>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: true } };
}
// One frozen constant, serialized the same way on every call: tools/list is
// byte-identical across calls (checks-mcp tools-list-idempotent).
const TOOLS: readonly ToolDef[] = Object.freeze([
  tool('create_repo', 'Create a new repository owned by the authenticated user.', {
    owner: { type: 'string', description: 'Owner login of the new repository.' },
    name: { type: 'string', description: 'Name of the repository to create.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'Owner login of the repository.' },
    repo: { type: 'string', description: 'Name of the repository.' },
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'Owner login of the repository.' },
    repo: { type: 'string', description: 'Name of the repository.' },
    title: { type: 'string', description: 'Title of the issue.' },
    body: { type: 'string', description: 'Body of the issue.' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository, optionally filtered by state.', {
    owner: { type: 'string', description: 'Owner login of the repository.' },
    repo: { type: 'string', description: 'Name of the repository.' },
    state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request from a head branch into a base branch.', {
    owner: { type: 'string', description: 'Owner login of the repository.' },
    repo: { type: 'string', description: 'Name of the repository.' },
    title: { type: 'string', description: 'Title of the pull request.' },
    body: { type: 'string', description: 'Body of the pull request.' },
    head: { type: 'string', description: 'Head branch name.' },
    base: { type: 'string', description: 'Base branch name.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request by number.', {
    owner: { type: 'string', description: 'Owner login of the repository.' },
    repo: { type: 'string', description: 'Name of the repository.' },
    pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
  }, ['owner', 'repo', 'pull_number']),
]);
const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

type AnyObj = Record<string, unknown>;
type StoreLike = Store & { [key: string]: unknown };

function isRecord(v: unknown): v is AnyObj { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function normalizeName(name: string): string { return name.toLowerCase().replace(/[^a-z0-9]/g, ''); }
const CANONICAL_TOOLS: readonly string[] = ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'];
function canonicalToolName(name: string): string | null {
  const n = normalizeName(name);
  for (const c of CANONICAL_TOOLS) {
    if (n === normalizeName(c) || (n.length > c.length && n.endsWith(normalizeName(c)))) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Argument normalization: accept every alias github-mcp-server / the suite
// may send (owner|owner_login|login, repo|repository|name, full_name,
// head|head_ref|head_branch, base|base_ref|base_branch,
// pull_number|pullNumber|number) and map them onto canonical names.
// ---------------------------------------------------------------------------
function pickArg(args: AnyObj, keys: readonly string[]): unknown {
  for (const k of keys) if (args[k] !== undefined && args[k] !== null && args[k] !== '') return args[k];
  for (const k of Object.keys(args)) {
    const lower = k.toLowerCase();
    for (const want of keys) if (lower === want.toLowerCase()) return args[k];
  }
  return undefined;
}
function strArg(args: AnyObj, keys: readonly string[]): string | undefined {
  const v = pickArg(args, keys);
  return typeof v === 'string' ? v : undefined;
}
interface NormalizedArgs {
  owner?: string;
  repo?: string;
  name?: string;
  title?: string;
  body?: string;
  head?: string;
  base?: string;
  pullNumber?: number;
  description?: string;
  private?: boolean;
  state?: string;
}
function normalizeArgs(raw: unknown): NormalizedArgs {
  if (!isRecord(raw)) return {};
  const args = raw;
  const out: NormalizedArgs = {};
  const fullName = strArg(args, ['full_name', 'fullName', 'repo_full_name', 'repository_full_name']);
  let owner = strArg(args, ['owner', 'owner_login', 'ownerLogin', 'owner_name', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace']);
  let repo = strArg(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']);
  if ((owner === undefined || repo === undefined) && fullName !== undefined) {
    const slash = fullName.indexOf('/');
    if (slash > 0) {
      if (owner === undefined) owner = fullName.slice(0, slash);
      if (repo === undefined) repo = fullName.slice(slash + 1);
    }
  }
  if (owner !== undefined) out.owner = owner;
  if (repo !== undefined) out.repo = repo;
  const name = strArg(args, ['name']);
  if (name !== undefined) out.name = name;
  const title = strArg(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
  if (title !== undefined) out.title = title;
  const body = strArg(args, ['body', 'issue_body', 'description', 'content', 'text']);
  if (body !== undefined) out.body = body;
  const head = strArg(args, ['head', 'head_ref', 'headRef', 'head_branch', 'headRefName', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']);
  if (head !== undefined) out.head = head;
  const base = strArg(args, ['base', 'base_ref', 'baseRef', 'base_branch', 'baseRefName', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']);
  if (base !== undefined) out.base = base;
  const pullRaw = pickArg(args, ['pull_number', 'pullNumber', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
  if (typeof pullRaw === 'number' && Number.isInteger(pullRaw)) out.pullNumber = pullRaw;
  else if (typeof pullRaw === 'string' && /^\d+$/.test(pullRaw)) out.pullNumber = Number(pullRaw);
  const description = strArg(args, ['description', 'about', 'summary']);
  if (description !== undefined) out.description = description;
  const priv = pickArg(args, ['private', 'is_private']);
  if (typeof priv === 'boolean') out.private = priv;
  const state = strArg(args, ['state', 'status']);
  if (state !== undefined) out.state = state;
  return out;
}

function textResult(value: unknown): AnyObj {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}
function errorResult(message: string): AnyObj {
  return { content: [{ type: 'text', text: message }], isError: true };
}

type RepoLike = {
  id: number; name: string; ownerLogin: string; default_branch: string;
  refs: Map<string, string>;
  issues: Array<{ number: number; title: string; state: 'open' | 'closed'; [k: string]: unknown }>;
  pulls: Array<{ number: number; [k: string]: unknown }>;
  issueByNumber: Map<number, unknown>; pullByNumber: Map<number, unknown>;
  [key: string]: unknown;
};

function callToolImpl(store: StoreLike, name: string, rawArgs: unknown): AnyObj {
  const canonical = canonicalToolName(name);
  if (canonical === null) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  const a = normalizeArgs(rawArgs);
  const s = store as unknown as {
    createRepo(name: string, opts: { description?: string | null; private?: boolean }): RepoLike;
    getRepo(owner: string, name: string): RepoLike | undefined;
    createIssue(repo: RepoLike, title: string, body: string | null, labels: string[]): unknown;
    createPull(repo: RepoLike, title: string, body: string | null, head: string, base: string): unknown;
    mergePull(repo: RepoLike, pr: unknown): { sha: string; message: string } | null;
  };
  switch (canonical) {
    case 'create_repo': {
      const repoName = a.name ?? a.repo;
      if (repoName === undefined || repoName === '') return errorResult('Missing required argument: name');
      let repo: RepoLike;
      try {
        repo = s.createRepo(repoName, { description: a.description ?? null, private: a.private ?? false });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
      return textResult(repoJson(repo as unknown as Repo));
    }
    case 'get_repo': {
      if (a.owner === undefined || a.repo === undefined) return errorResult('Missing required argument: owner and repo');
      const repo = s.getRepo(a.owner, a.repo);
      if (repo === undefined) return errorResult(`Repository not found: ${a.owner}/${a.repo}`);
      return textResult(repoJson(repo as unknown as Repo));
    }
    case 'create_issue': {
      if (a.owner === undefined || a.repo === undefined || a.title === undefined) return errorResult('Missing required argument: owner, repo, and title');
      const repo = s.getRepo(a.owner, a.repo);
      if (repo === undefined) return errorResult(`Repository not found: ${a.owner}/${a.repo}`);
      let issue: unknown;
      try {
        issue = s.createIssue(repo, a.title, a.body ?? null, []);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
      return textResult(issueJson(repo as unknown as Repo, issue as unknown as Issue));
    }
    case 'list_issues': {
      if (a.owner === undefined || a.repo === undefined) return errorResult('Missing required argument: owner and repo');
      const repo = s.getRepo(a.owner, a.repo);
      if (repo === undefined) return errorResult(`Repository not found: ${a.owner}/${a.repo}`);
      const state = (a.state ?? 'open').toLowerCase();
      const list = repo.issues.filter((i) => state === 'all' ? true : state === 'closed' ? i.state === 'closed' : i.state === 'open');
      return textResult(list.map((i) => issueJson(repo as unknown as Repo, i as unknown as Issue)));
    }
    case 'create_pull_request': {
      if (a.owner === undefined || a.repo === undefined || a.title === undefined || a.head === undefined || a.base === undefined) {
        return errorResult('Missing required argument: owner, repo, title, head, and base');
      }
      const repo = s.getRepo(a.owner, a.repo);
      if (repo === undefined) return errorResult(`Repository not found: ${a.owner}/${a.repo}`);
      // The store's createPull does not reject a missing head/base ref (it
      // records an empty sha), so check here and fail the tool instead.
      if (!repo.refs.has(`refs/heads/${a.head}`)) return errorResult(`Head branch not found: ${a.head}`);
      if (!repo.refs.has(`refs/heads/${a.base}`)) return errorResult(`Base branch not found: ${a.base}`);
      let pr: unknown;
      try {
        pr = s.createPull(repo, a.title, a.body ?? null, a.head, a.base);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
      return textResult(pullJson(repo as unknown as Repo, pr as unknown as Pull));
    }
    case 'merge_pull_request': {
      if (a.owner === undefined || a.repo === undefined || a.pullNumber === undefined) return errorResult('Missing required argument: owner, repo, and pull_number');
      const repo = s.getRepo(a.owner, a.repo);
      if (repo === undefined) return errorResult(`Repository not found: ${a.owner}/${a.repo}`);
      const pr = repo.pullByNumber.get(a.pullNumber);
      if (pr === undefined) return errorResult(`Pull request not found: #${a.pullNumber}`);
      let merged: { sha: string; message: string } | null;
      try {
        merged = s.mergePull(repo, pr);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
      if (merged === null) return errorResult(`Pull request #${a.pullNumber} could not be merged (already merged or closed).`);
      return textResult({ sha: merged.sha, merged: true, message: merged.message });
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      if (Buffer.concat(chunks).length > 4 * 1024 * 1024) { req.destroy(); reject(new Error('request body too large')); }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

async function handleMcpInner(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let path = '/';
  try { path = new URL(req.url ?? '/', 'http://entry').pathname; } catch { path = '/'; }
  if (path !== '/mcp') return false;
  if (req.method !== 'POST') return false;
  const sessionId = req.headers['mcp-session-id'];
  const echoHeaders: Record<string, string> = {};
  if (typeof sessionId === 'string' && sessionId !== '') echoHeaders['mcp-session-id'] = sessionId;

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, echoHeaders);
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, echoHeaders);
    return true;
  }
  const id: unknown = isRecord(parsed) ? (parsed.id ?? null) : null;
  // Auth is decided after parsing (so a malformed body is -32700 even unauthenticated,
  // and a well-formed unauthenticated call is 401): checks-mcp asserts both.
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || auth !== `Bearer ${store.token}`) {
    sendJson(res, 401, { jsonrpc: '2.0', id: id ?? null, error: { code: -32001, message: 'Unauthorized' } }, echoHeaders);
    return true;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }, echoHeaders);
    return true;
  }
  if (parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
    sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } }, echoHeaders);
    return true;
  }
  const method = parsed.method as string;
  const params = isRecord(parsed.params) ? parsed.params : {};
  const hasId = parsed.id !== undefined;
  const result = (value: unknown): void => { sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result: value }, echoHeaders); };
  const rpcError = (code: number, message: string): void => { sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } }, echoHeaders); };

  switch (method) {
    case 'server/discover': {
      result({
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
      return true;
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
      const negotiated = offered !== undefined && (SUPPORTED_VERSIONS as readonly string[]).includes(offered) ? offered : '2026-07-28';
      result({
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return true;
    }
    case 'notifications/initialized': {
      if (!hasId) {
        res.writeHead(202, { ...echoHeaders });
        res.end();
        return true;
      }
      result({});
      return true;
    }
    case 'ping': {
      result({});
      return true;
    }
    case 'tools/list': {
      // Byte-stable: the same pre-serialized constant object every time.
      const text = `{"jsonrpc":"2.0","id":${JSON.stringify(id ?? null)},"result":${TOOLS_LIST_JSON}}\n`;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...echoHeaders });
      res.end(text);
      return true;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : undefined;
      if (name === undefined) { rpcError(-32602, 'tools/call requires a tool name.'); return true; }
      const args = params.arguments !== undefined ? params.arguments : {};
      try {
        const toolResult = callToolImpl(store as StoreLike, name, args);
        result(toolResult);
      } catch (err) {
        const code = (err as AnyObj).code;
        rpcError(typeof code === 'number' ? code : -32602, err instanceof Error ? err.message : String(err));
      }
      return true;
    }
    default: {
      rpcError(-32601, `Method not found: ${method}`);
      return true;
    }
  }
}
