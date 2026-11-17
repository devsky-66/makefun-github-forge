// GitHub REST v3 处理器（REST+Store 组）。
// 断言来源：kit/program/env/src/checks-rest.ts（repos 15 + issues 15 + pulls 20 + protocol 5）。
// 只用 Node 标准库；/api/v3 下全部路由要求 Bearer token（与 store.token 比对）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit, parseTree } from './objects.ts';
import {
  OWNER_ID,
  OWNER_LOGIN,
  commitFiles,
  issueJson,
  labelJson,
  mergeBase,
  parseIdentity,
  pullJson,
  repoJson,
  syncContentsFromTree,
  treeFileMap,
  type Label,
  type Repo,
  type Store,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const SCOPES = 'repo, read:org';
const SHA40 = /^[0-9a-f]{40}$/;

function send(res: ServerResponse, store: Store, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': store.nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendErr(res: ServerResponse, store: Store, status: number, message: string): void {
  send(res, store, status, { message });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  return { page, perPage };
}

/** 分页切片 + Link 头（绝对 URL，留在本 origin）。 */
function paginate<T>(req: IncomingMessage, res: ServerResponse, store: Store, items: T[], query: URLSearchParams): T[] {
  const { page, perPage } = parsePage(query);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  if (pages > 1) {
    const host = req.headers.host ?? 'localhost';
    const url = new URL(req.url ?? '/', `http://${host}`);
    const links: string[] = [];
    const mk = (p: number, rel: string): string => {
      const u = new URL(url.toString());
      u.searchParams.set('page', String(p));
      u.searchParams.set('per_page', String(perPage));
      return `<${u.toString()}>; rel="${rel}"`;
    };
    if (page < pages) {
      links.push(mk(page + 1, 'next'), mk(pages, 'last'));
    }
    if (page > 1) {
      links.push(mk(1, 'first'), mk(page - 1, 'prev'));
    }
    // Link 头必须在 send 之前设定：由调用方把 header 传给 send；这里返回后调用方处理。
    // 为简单起见，直接写到 res 上（send 用 writeHead 会合并已设置的 header）。
    res.setHeader('link', links.join(', '));
  }
  return slice;
}

function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** ref 查询参数解析：分支名或 commit sha；默认默认分支。返回 tip commit sha 或 undefined。 */
function resolveRef(repo: Repo, refParam: string | null): string | undefined {
  if (refParam === null || refParam === '') return branchTip(repo, repo.default_branch);
  const byBranch = branchTip(repo, refParam);
  if (byBranch !== undefined) return byBranch;
  if (SHA40.test(refParam) && repo.objects.has(refParam)) return refParam;
  return undefined;
}

/** 某提交树下的目录 → 子树 sha（供目录列表用）。 */
function dirTreeShas(repo: Repo, commitSha: string): Map<string, string> {
  const out = new Map<string, string>();
  const commit = repo.objects.get(commitSha);
  if (commit === undefined || commit.type !== 'commit') return out;
  const walk = (treeSha: string, prefix: string): void => {
    out.set(prefix, treeSha);
    const obj = repo.objects.get(treeSha);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') walk(e.sha, prefix === '' ? e.name : `${prefix}/${e.name}`);
    }
  };
  walk(parseCommit(commit.data).tree, '');
  return out;
}

function commitJson(repo: Repo, sha: string): any {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const author = parseIdentity(c.author);
  const committer = parseIdentity(c.committer);
  const user = { login: OWNER_LOGIN, id: OWNER_ID, type: 'User', avatar_url: `https://avatars.githubusercontent.com/u/${OWNER_ID}?v=4`, html_url: `https://github.com/${OWNER_LOGIN}` };
  return {
    sha,
    node_id: `C_${sha}`,
    url: `https://api.github.com/repos/${OWNER_LOGIN}/${repo.name}/commits/${sha}`,
    html_url: `https://github.com/${OWNER_LOGIN}/${repo.name}/commit/${sha}`,
    comments_url: `https://api.github.com/repos/${OWNER_LOGIN}/${repo.name}/commits/${sha}/comments`,
    commit: {
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      message: c.message,
      tree: { sha: c.tree, url: `https://api.github.com/repos/${OWNER_LOGIN}/${repo.name}/git/trees/${c.tree}` },
      url: `https://api.github.com/repos/${OWNER_LOGIN}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
    },
    author: user,
    committer: user,
    parents: c.parents.map((p) => ({ sha: p, url: `https://api.github.com/repos/${OWNER_LOGIN}/${repo.name}/commits/${p}`, html_url: `https://github.com/${OWNER_LOGIN}/${repo.name}/commit/${p}` })),
  };
}

/** 从 tip 向祖先遍历（DFS，最新在前），返回 commit sha 列表。 */
function commitHistory(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(cur);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return out;
}

/** 行级 diff 计数（LCS，文件小，可直接 DP）。 */
function lineDiff(oldBuf: Buffer | undefined, newBuf: Buffer | undefined): { additions: number; deletions: number } {
  const oldLines = oldBuf === undefined ? [] : oldBuf.toString('utf8').split('\n');
  const newLines = newBuf === undefined ? [] : newBuf.toString('utf8').split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const n = oldLines.length;
  const m = newLines.length;
  // LCS 长度 DP（仅两行滚动数组）。
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    cur[0] = 0;
    for (let j = 1; j <= m; j += 1) {
      cur[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const lcs = prev[m] as number;
  return { additions: m - lcs, deletions: n - lcs };
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    return false;
  }
  const pathname = url.pathname;
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) return false;
  const method = (req.method ?? 'GET').toUpperCase();
  const query = url.searchParams;

  // 鉴权：/api/v3 下全部路由都要 Bearer token（checks: 无 token → 401；错 token → 401）。
  const auth = req.headers.authorization ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const authed = store.token !== '' ? bearer === store.token && bearer !== '' : bearer !== '';
  if (!authed) {
    sendErr(res, store, 401, 'Requires authentication');
    return true;
  }

  // 请求体：有内容才解析 JSON；畸形 → 400。
  let body: any = {};
  let hasBody = false;
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    const raw = await readBody(req);
    if (raw.trim() !== '') {
      hasBody = true;
      try {
        body = JSON.parse(raw);
      } catch {
        sendErr(res, store, 400, 'Problems parsing JSON');
        return true;
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        // JSON 标量/数组作为请求体：按对象缺字段处理，下游按字段缺失返回 422；
        // 但根级非对象在这里直接 400 更符合 malformed 语义？checks 只测畸形 JSON，
        // 此处把非对象体当作空对象，避免误杀。
        body = {};
      }
    }
  }
  void hasBody;

  const tail = pathname === '/api/v3' ? '' : pathname.slice('/api/v3/'.length);
  const segs = tail === '' ? [] : tail.split('/').map(decodeSeg);

  // GET /api/v3/ —— API 根
  if (segs.length === 0) {
    if (method !== 'GET') {
      sendErr(res, store, 404, 'Not Found');
      return true;
    }
    send(res, store, 200, { current_user_url: '/api/v3/user', current_user_authorizations_html_url: 'https://github.com/settings/applications', authorizations_url: '/api/v3/authorizations', code_search_url: '/api/v3/search/code?q={query}', commit_search_url: '/api/v3/search/commits?q={query}', emails_url: '/api/v3/user/emails', emojis_url: '/api/v3/emojis', events_url: '/api/v3/events', feeds_url: '/api/v3/feeds', followers_url: '/api/v3/user/followers', following_url: '/api/v3/user/following{/target}', gists_url: '/api/v3/gists{/gist_id}', hub_url: '/api/v3/hub', issue_search_url: '/api/v3/search/issues?q={query}', issues_url: '/api/v3/issues', keys_url: '/api/v3/user/keys', label_search_url: '/api/v3/search/labels?q={query}', notifications_url: '/api/v3/notifications', organization_url: '/api/v3/orgs/{org}', public_gists_url: '/api/v3/gists/public', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}', repository_search_url: '/api/v3/search/repositories?q={query}', current_user_repositories_url: '/api/v3/user/repos', starred_url: '/api/v3/user/starred{/owner}{/repo}', starred_gists_url: '/api/v3/gists/starred', topic_search_url: '/api/v3/search/topics?q={query}', user_url: '/api/v3/users/{user}', user_organizations_url: '/api/v3/user/orgs', user_repositories_url: '/api/v3/users/{user}/repos', user_search_url: '/api/v3/search/users?q={query}' }, { 'x-oauth-scopes': SCOPES });
    return true;
  }

  // GET /api/v3/meta
  if (segs.length === 1 && segs[0] === 'meta') {
    if (method !== 'GET') {
      sendErr(res, store, 404, 'Not Found');
      return true;
    }
    send(res, store, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }

  // /api/v3/user/repos
  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'GET') {
      const all = [...store.repos.values()].sort((a, b) => a.id - b.id).map((r) => repoJson(r));
      const page = paginate(req, res, store, all, query);
      send(res, store, 200, page);
      return true;
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') {
        sendErr(res, store, 422, 'name is required');
        return true;
      }
      if (store.getRepo(OWNER_LOGIN, name) !== undefined) {
        sendErr(res, store, 422, 'Repository creation failed. name already exists on this account');
        return true;
      }
      const repo = store.createRepo(name, {
        description: typeof body.description === 'string' || body.description === null ? body.description : null,
        private: body.private === true,
        default_branch: typeof body.default_branch === 'string' && body.default_branch !== '' ? body.default_branch : undefined,
      });
      send(res, store, 201, repoJson(repo));
      return true;
    }
    sendErr(res, store, 404, 'Not Found');
    return true;
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (segs.length >= 3 && segs[0] === 'repos') {
    const owner = segs[1] as string;
    const repoName = segs[2] as string;
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendErr(res, store, 404, 'Not Found');
      return true;
    }
    const rest = segs.slice(3);
    const base = `https://api.github.com/repos/${OWNER_LOGIN}/${repo.name}`;

    // /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        send(res, store, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        if (typeof body.description === 'string' || body.description === null) repo.description = body.description;
        if (body.private === true || body.private === false) repo.private = body.private;
        if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.default_branch = body.default_branch;
        if (typeof body.name === 'string' && body.name.trim() !== '' && body.name !== repo.name) {
          const next = body.name.trim();
          if (store.getRepo(OWNER_LOGIN, next) !== undefined) {
            sendErr(res, store, 422, 'Repository creation failed. name already exists on this account');
            return true;
          }
          store.repos.delete(`${OWNER_LOGIN}/${repo.name}`);
          repo.name = next;
          store.repos.set(`${OWNER_LOGIN}/${repo.name}`, repo);
        }
        repo.updated_at = store.nowIso();
        send(res, store, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        send(res, store, 204, null);
        return true;
      }
      sendErr(res, store, 404, 'Not Found');
      return true;
    }

    const head = rest[0] as string;

    // ---- branches ----
    if (head === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .map((r) => r.slice('refs/heads/'.length))
          .sort()
          .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) as string, url: `${base}/commits/${repo.refs.get(`refs/heads/${name}`)}` }, protected: false }));
        send(res, store, 200, list);
        return true;
      }
      if (rest.length >= 2 && method === 'GET') {
        const branch = rest.slice(1).join('/');
        const sha = branchTip(repo, branch);
        if (sha === undefined) {
          sendErr(res, store, 404, 'Branch not found');
          return true;
        }
        send(res, store, 200, { name: branch, commit: { sha, url: `${base}/commits/${sha}` }, protected: false, protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } } });
        return true;
      }
      sendErr(res, store, 404, 'Not Found');
      return true;
    }

    // ---- commits ----
    if (head === 'commits') {
      if (rest.length === 1 && method === 'GET') {
        const tip = resolveRef(repo, query.get('sha'));
        if (tip === undefined) {
          // 空库或 ref 不存在：空库返回 []；ref 明确不存在返回 404。
          if (repo.refs.size === 0 && (query.get('sha') === null || query.get('sha') === repo.default_branch)) {
            send(res, store, 200, []);
            return true;
          }
          sendErr(res, store, 404, 'No commit found for SHA: ' + (query.get('sha') ?? ''));
          return true;
        }
        const history = commitHistory(repo, tip).map((sha) => commitJson(repo, sha)).filter((c) => c !== null);
        const page = paginate(req, res, store, history, query);
        send(res, store, 200, page);
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const sha = rest[1] as string;
        let found = sha;
        if (!repo.objects.has(sha)) {
          // 短 sha 前缀匹配（唯一时）。
          const matches = [...repo.objects.keys()].filter((k) => k.startsWith(sha));
          if (matches.length === 1) found = matches[0] as string;
        }
        const view = commitJson(repo, found);
        if (view === null) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        send(res, store, 200, view);
        return true;
      }
      sendErr(res, store, 404, 'Not Found');
      return true;
    }

    // ---- git/refs ----
    if (head === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !SHA40.test(sha)) {
          sendErr(res, store, 422, 'Invalid ref or sha');
          return true;
        }
        if (!repo.objects.has(sha)) {
          sendErr(res, store, 422, 'Invalid SHA');
          return true;
        }
        if (repo.refs.has(ref)) {
          sendErr(res, store, 422, 'Reference already exists');
          return true;
        }
        repo.refs.set(ref, sha);
        const obj = repo.objects.get(sha);
        send(res, store, 201, { ref, node_id: `REF_${ref}`, url: `${base}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: obj?.type ?? 'commit', url: `${base}/git/${obj?.type ?? 'commit'}s/${sha}` } });
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const list = [...repo.refs.entries()].sort().map(([ref, sha]) => ({ ref, node_id: `REF_${ref}`, url: `${base}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `${base}/git/commits/${sha}` } }));
        send(res, store, 200, list);
        return true;
      }
      if (rest.length >= 3 && method === 'GET') {
        const joined = rest.slice(2).join('/');
        const ref = joined.startsWith('refs/') ? joined : `refs/${joined}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        const obj = repo.objects.get(sha);
        send(res, store, 200, { ref, node_id: `REF_${ref}`, url: `${base}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: obj?.type ?? 'commit', url: `${base}/git/commits/${sha}` } });
        return true;
      }
      sendErr(res, store, 404, 'Not Found');
      return true;
    }
    // /git/ref/... 兼容别名
    if (head === 'git' && rest[1] === 'ref' && method === 'GET') {
      const joined = rest.slice(2).join('/');
      const ref = joined.startsWith('refs/') ? joined : `refs/${joined}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) {
        sendErr(res, store, 404, 'Not Found');
        return true;
      }
      send(res, store, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      return true;
    }

    // ---- contents ----
    if (head === 'contents') {
      const path = rest.slice(1).join('/');
      const refParam = query.get('ref');
      if (method === 'GET') {
        const tip = resolveRef(repo, refParam);
        if (tip === undefined) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        const files = treeFileMap(repo, tip);
        const dirs = dirTreeShas(repo, tip);
        if (path === '') {
          // 根目录列表。
          const entries = listDir(repo, tip, files, dirs, '');
          send(res, store, 200, entries);
          return true;
        }
        const file = files.get(path);
        if (file !== undefined) {
          const name = path.slice(path.lastIndexOf('/') + 1);
          send(res, store, 200, {
            type: 'file', encoding: 'base64', size: file.content.length, name, path, content: file.content.toString('base64'),
            sha: file.sha, url: `${base}/contents/${encodeURIComponent(path)}`, git_url: `${base}/git/blobs/${file.sha}`,
            html_url: `https://github.com/${OWNER_LOGIN}/${repo.name}/blob/${repo.default_branch}/${path}`,
            download_url: `https://raw.githubusercontent.com/${OWNER_LOGIN}/${repo.name}/${repo.default_branch}/${path}`,
          });
          return true;
        }
        if (dirs.has(path)) {
          send(res, store, 200, listDir(repo, tip, files, dirs, path));
          return true;
        }
        sendErr(res, store, 404, 'Not Found');
        return true;
      }
      if (method === 'PUT') {
        if (path === '') {
          sendErr(res, store, 422, 'Invalid path');
          return true;
        }
        const message = typeof body.message === 'string' ? body.message : '';
        if (message === '') {
          sendErr(res, store, 422, 'message is required');
          return true;
        }
        if (typeof body.content !== 'string') {
          sendErr(res, store, 422, 'content is required');
          return true;
        }
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
        const tip = branchTip(repo, branch);
        const files = tip === undefined ? new Map<string, Buffer>() : new Map([...treeFileMap(repo, tip)].map(([p, e]) => [p, e.content] as [string, Buffer]));
        const existing = files.get(path);
        const sha = typeof body.sha === 'string' ? body.sha : undefined;
        let isUpdate = false;
        if (existing !== undefined) {
          if (sha === undefined) {
            sendErr(res, store, 422, 'sha is required to update a file');
            return true;
          }
          const curSha = treeFileMap(repo, tip as string).get(path)?.sha;
          if (sha !== curSha) {
            sendErr(res, store, 409, 'sha does not match the current blob');
            return true;
          }
          isUpdate = true;
        } else if (sha !== undefined) {
          sendErr(res, store, 409, 'sha does not match the current blob');
          return true;
        }
        const content = Buffer.from(body.content.replace(/[\r\n\t ]+/g, ''), 'base64');
        files.set(path, content);
        const commitSha = commitFiles(repo, branch, files, message);
        const newFiles = treeFileMap(repo, commitSha);
        const entry = newFiles.get(path) as { sha: string; content: Buffer };
        const name = path.slice(path.lastIndexOf('/') + 1);
        const entry0 = repo.contents.get(path);
        if (entry0 !== undefined) entry0.message = message;
        send(res, store, isUpdate ? 200 : 201, {
          content: { name, path, sha: entry.sha, size: entry.content.length, url: `${base}/contents/${encodeURIComponent(path)}`, html_url: `https://github.com/${OWNER_LOGIN}/${repo.name}/blob/${branch}/${path}`, git_url: `${base}/git/blobs/${entry.sha}`, download_url: `https://raw.githubusercontent.com/${OWNER_LOGIN}/${repo.name}/${branch}/${path}`, type: 'file', content: entry.content.toString('base64'), encoding: 'base64' },
          commit: { sha: commitSha, message, author: { name: OWNER_LOGIN, email: `${OWNER_LOGIN}@example.invalid`, date: store.nowIso() }, committer: { name: OWNER_LOGIN, email: `${OWNER_LOGIN}@example.invalid`, date: store.nowIso() }, url: `${base}/git/commits/${commitSha}` },
        });
        return true;
      }
      if (method === 'DELETE') {
        if (path === '') {
          sendErr(res, store, 422, 'Invalid path');
          return true;
        }
        const message = typeof body.message === 'string' ? body.message : '';
        if (message === '') {
          sendErr(res, store, 422, 'message is required');
          return true;
        }
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
        const tip = branchTip(repo, branch);
        if (tip === undefined) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        const files = new Map([...treeFileMap(repo, tip)].map(([p, e]) => [p, e.content] as [string, Buffer]));
        if (!files.has(path)) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        const sha = typeof body.sha === 'string' ? body.sha : undefined;
        if (sha !== undefined) {
          const curSha = treeFileMap(repo, tip).get(path)?.sha;
          if (sha !== curSha) {
            sendErr(res, store, 409, 'sha does not match the current blob');
            return true;
          }
        }
        files.delete(path);
        const commitSha = commitFiles(repo, branch, files, message);
        send(res, store, 200, { commit: { sha: commitSha, message, url: `${base}/git/commits/${commitSha}` }, content: null });
        return true;
      }
      sendErr(res, store, 404, 'Not Found');
      return true;
    }

    // ---- labels ----
    if (head === 'labels') {
      if (rest.length === 1 && method === 'GET') {
        send(res, store, 200, [...repo.labels.values()].map((l) => ({ ...labelJson(l), url: `${base}/labels/${encodeURIComponent(l.name)}` })));
        return true;
      }
      if (rest.length === 1 && method === 'POST') {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '') {
          sendErr(res, store, 422, 'name is required');
          return true;
        }
        const existing = repo.labels.get(name);
        if (existing !== undefined) {
          send(res, store, 201, { ...labelJson(existing), url: `${base}/labels/${encodeURIComponent(name)}` });
          return true;
        }
        const label: Label = {
          name,
          color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
          description: typeof body.description === 'string' ? body.description : '',
        };
        repo.labels.set(name, label);
        send(res, store, 201, { ...labelJson(label), url: `${base}/labels/${encodeURIComponent(name)}` });
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const label = repo.labels.get(rest[1] as string);
        if (label === undefined) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        send(res, store, 200, { ...labelJson(label), url: `${base}/labels/${encodeURIComponent(label.name)}` });
        return true;
      }
      sendErr(res, store, 404, 'Not Found');
      return true;
    }

    // ---- issues ----
    if (head === 'issues') {
      if (rest.length === 1 && method === 'GET') {
        let list = [...repo.issues];
        const state = query.get('state') ?? 'open';
        if (state !== 'all') list = list.filter((i) => i.state === state);
        const labelsParam = query.get('labels');
        if (labelsParam !== null && labelsParam !== '') {
          const wanted = labelsParam.split(',').map((s) => s.trim()).filter((s) => s !== '');
          list = list.filter((i) => wanted.every((w) => i.labels.includes(w)));
        }
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        } else if (sort === 'updated') {
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        }
        const page = paginate(req, res, store, list, query).map((i) => issueJson(repo, i));
        send(res, store, 200, page);
        return true;
      }
      if (rest.length === 1 && method === 'POST') {
        const title = typeof body.title === 'string' ? body.title : '';
        if (title === '') {
          sendErr(res, store, 422, 'title is required');
          return true;
        }
        const rawLabels: unknown[] = Array.isArray(body.labels) ? body.labels : [];
        const labels: string[] = [];
        for (const item of rawLabels) {
          if (typeof item === 'string') labels.push(item);
          else if (item !== null && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') labels.push((item as { name: string }).name);
        }
        for (const name of labels) {
          if (!repo.labels.has(name)) {
            sendErr(res, store, 422, `Label '${name}' does not exist`);
            return true;
          }
        }
        const issue = store.createIssue(repo, title, typeof body.body === 'string' || body.body === null ? body.body : null, labels);
        send(res, store, 201, issueJson(repo, issue));
        return true;
      }
      if (rest.length === 2) {
        const n = Number(rest[1]);
        if (!Number.isInteger(n)) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        const issue = store.getIssue(repo, n);
        if (issue === undefined) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          send(res, store, 200, issueJson(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string' || body.body === null) issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') {
            issue.state = body.state;
            issue.closed_at = body.state === 'closed' ? store.nowIso() : null;
          } else if (body.state !== undefined) {
            sendErr(res, store, 422, 'Invalid state');
            return true;
          }
          if (Array.isArray(body.labels)) {
            const labels: string[] = [];
            for (const item of body.labels as unknown[]) {
              if (typeof item === 'string') labels.push(item);
              else if (item !== null && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') labels.push((item as { name: string }).name);
            }
            for (const name of labels) {
              if (!repo.labels.has(name)) {
                sendErr(res, store, 422, `Label '${name}' does not exist`);
                return true;
              }
            }
            issue.labels = labels;
          }
          issue.updated_at = store.nowIso();
          send(res, store, 200, issueJson(repo, issue));
          return true;
        }
        sendErr(res, store, 404, 'Not Found');
        return true;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const n = Number(rest[1]);
        if (!Number.isInteger(n)) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        const issue = store.getIssue(repo, n);
        if (issue === undefined) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          const list = repo.issueComments.get(n) ?? [];
          const page = paginate(req, res, store, [...list], query).map((c) => ({
            id: c.id, node_id: `IC_${c.id}`, url: `${base}/issues/comments/${c.id}`, html_url: `https://github.com/${OWNER_LOGIN}/${repo.name}/issues/${n}#issuecomment-${c.id}`,
            body: c.body, user: { login: c.user.login, id: c.user.id, type: 'User', avatar_url: `https://avatars.githubusercontent.com/u/${c.user.id}?v=4`, html_url: `https://github.com/${c.user.login}` },
            created_at: c.created_at, updated_at: c.updated_at, author_association: 'OWNER',
          }));
          send(res, store, 200, page);
          return true;
        }
        if (method === 'POST') {
          const cbody = typeof body.body === 'string' ? body.body : '';
          if (cbody === '') {
            sendErr(res, store, 422, 'body is required');
            return true;
          }
          const comment = { id: store.commentIdSeq, body: cbody, user: { login: OWNER_LOGIN, id: OWNER_ID }, created_at: store.nowIso(), updated_at: store.nowIso() };
          store.commentIdSeq += 1;
          const list = repo.issueComments.get(n) ?? [];
          list.push(comment);
          repo.issueComments.set(n, list);
          issue.comments = list.length;
          send(res, store, 201, {
            id: comment.id, node_id: `IC_${comment.id}`, url: `${base}/issues/comments/${comment.id}`, html_url: `https://github.com/${OWNER_LOGIN}/${repo.name}/issues/${n}#issuecomment-${comment.id}`,
            body: comment.body, user: { login: OWNER_LOGIN, id: OWNER_ID, type: 'User', avatar_url: `https://avatars.githubusercontent.com/u/${OWNER_ID}?v=4`, html_url: `https://github.com/${OWNER_LOGIN}` },
            created_at: comment.created_at, updated_at: comment.updated_at, author_association: 'OWNER',
          });
          return true;
        }
        sendErr(res, store, 404, 'Not Found');
        return true;
      }
      sendErr(res, store, 404, 'Not Found');
      return true;
    }

    // ---- pulls ----
    if (head === 'pulls') {
      if (rest.length === 1 && method === 'GET') {
        let list = [...repo.pulls];
        const state = query.get('state') ?? 'open';
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => b.number - a.number);
        const page = paginate(req, res, store, list, query).map((p) => pullJson(repo, p));
        send(res, store, 200, page);
        return true;
      }
      if (rest.length === 1 && method === 'POST') {
        const title = typeof body.title === 'string' ? body.title : '';
        if (title === '') {
          sendErr(res, store, 422, 'title is required');
          return true;
        }
        let headRef = typeof body.head === 'string' ? body.head : '';
        if (headRef.includes(':')) headRef = headRef.split(':').slice(1).join(':');
        const baseRef = typeof body.base === 'string' && body.base !== '' ? body.base : repo.default_branch;
        if (headRef === '') {
          sendErr(res, store, 422, 'head is required');
          return true;
        }
        if (branchTip(repo, headRef) === undefined) {
          sendErr(res, store, 422, `Invalid head branch '${headRef}'`);
          return true;
        }
        if (branchTip(repo, baseRef) === undefined) {
          sendErr(res, store, 422, `Invalid base branch '${baseRef}'`);
          return true;
        }
        const pr = store.createPull(repo, title, typeof body.body === 'string' || body.body === null ? body.body : null, headRef, baseRef);
        send(res, store, 201, pullJson(repo, pr));
        return true;
      }
      if (rest.length === 2) {
        const n = Number(rest[1]);
        if (!Number.isInteger(n)) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        const pr = store.getPull(repo, n);
        if (pr === undefined) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          send(res, store, 200, pullJson(repo, pr));
          return true;
        }
        sendErr(res, store, 404, 'Not Found');
        return true;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const n = Number(rest[1]);
        if (!Number.isInteger(n)) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        const pr = store.getPull(repo, n);
        if (pr === undefined) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        const headSha = branchTip(repo, pr.head.ref) ?? pr.head.sha;
        const baseSha = pr.base.sha;
        const headFiles = headSha !== '' ? treeFileMap(repo, headSha) : new Map();
        const baseFiles = baseSha !== '' ? treeFileMap(repo, baseSha) : new Map();
        const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
        const out: any[] = [];
        for (const path of [...paths].sort()) {
          const b = baseFiles.get(path);
          const h = headFiles.get(path);
          if (b !== undefined && h !== undefined && b.sha === h.sha) continue;
          const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
          const diff = lineDiff(b?.content, h?.content);
          out.push({
            sha: h?.sha ?? b?.sha ?? '',
            filename: path,
            status,
            additions: diff.additions,
            deletions: diff.deletions,
            changes: diff.additions + diff.deletions,
            blob_url: `https://github.com/${OWNER_LOGIN}/${repo.name}/blob/${headSha}/${path}`,
            raw_url: `https://raw.githubusercontent.com/${OWNER_LOGIN}/${repo.name}/${headSha}/${path}`,
            contents_url: `${base}/contents/${encodeURIComponent(path)}?ref=${headSha}`,
          });
        }
        send(res, store, 200, out);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const n = Number(rest[1]);
        if (!Number.isInteger(n)) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        const pr = store.getPull(repo, n);
        if (pr === undefined) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        const merged = store.mergePull(repo, pr);
        if (merged === null) {
          sendErr(res, store, 405, 'Merge conflict');
          return true;
        }
        send(res, store, 200, { sha: merged.sha, merged: true, message: merged.message });
        return true;
      }
      sendErr(res, store, 404, 'Not Found');
      return true;
    }

    sendErr(res, store, 404, 'Not Found');
    return true;
  }

  sendErr(res, store, 404, 'Not Found');
  return true;
}

/** 目录列表：直属子项（文件取 blob sha，目录取子树 sha）。 */
function listDir(repo: Repo, tip: string, files: Map<string, { sha: string; content: Buffer }>, dirs: Map<string, string>, dirPath: string): any[] {
  const base = `https://api.github.com/repos/${OWNER_LOGIN}/${repo.name}`;
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const seen = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      seen.set(rest, { type: 'file', name: rest, path, sha: entry.sha, size: entry.content.length });
    } else {
      const name = rest.slice(0, slash);
      const sub = `${prefix}${name}`;
      if (!seen.has(name)) seen.set(name, { type: 'dir', name, path: sub, sha: dirs.get(sub) ?? '', size: 0 });
    }
  }
  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((e) => ({
    type: e.type,
    size: e.size,
    name: e.name,
    path: e.path,
    sha: e.sha,
    url: `${base}/contents/${encodeURIComponent(e.path)}`,
    git_url: e.type === 'file' ? `${base}/git/blobs/${e.sha}` : `${base}/git/trees/${e.sha}`,
    html_url: `https://github.com/${OWNER_LOGIN}/${repo.name}/tree/${repo.default_branch}/${e.path}`,
    download_url: e.type === 'file' ? `https://raw.githubusercontent.com/${OWNER_LOGIN}/${repo.name}/${repo.default_branch}/${e.path}` : null,
  }));
}

export { mergeBase };
