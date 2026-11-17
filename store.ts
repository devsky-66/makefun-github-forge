// 内存存储 + 确定性时间 + JSON 视图（REST+Store 组）。
// 只用 Node 标准库；所有时间一律 nowIso()，不用 Date.now()/Math.random()。
import { formatCommit, formatTree, isAncestor, parseCommit, parseTree, storeObject } from './objects.ts';

export interface GitObject { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer; }
export interface Label { name: string; color: string; description: string; }
export interface IssueComment { id: number; body: string; user: { login: string; id: number }; created_at: string; updated_at: string; }
export interface Issue { id: number; number: number; title: string; body: string | null; state: 'open' | 'closed'; labels: string[]; user: { login: string; id: number }; created_at: string; updated_at: string; closed_at: string | null; comments: number; }
export interface Pull { id: number; number: number; title: string; body: string | null; state: 'open' | 'closed'; merged: boolean; mergeable: boolean | null; head: { label: string; ref: string; sha: string }; base: { label: string; ref: string; sha: string }; user: { login: string; id: number }; created_at: string; updated_at: string; merged_at: string | null; merge_commit_sha: string | null; }
export interface ContentEntry { path: string; sha: string; content: Buffer; message: string; }
export interface Repo {
  id: number; name: string; ownerLogin: string; description: string | null; default_branch: string; private: boolean;
  created_at: string; updated_at: string;
  refs: Map<string, string>; objects: Map<string, GitObject>; labels: Map<string, Label>;
  issues: Issue[]; pulls: Pull[]; contents: Map<string, ContentEntry>;
  issueSeq: number; prSeq: number; issueByNumber: Map<number, Issue>; pullByNumber: Map<number, Pull>;
  issueComments: Map<number, IssueComment[]>;
}

export const OWNER_LOGIN = 'adaiversen';
export const OWNER_ID = 1000;
/** 固定 commit epoch（2025-01-01T00:00:00Z），与场景 epoch 一致。 */
export const FIXED_EPOCH_SEC = 1735689600;
const FALLBACK_NOW = '2025-01-01T00:00:00.000Z';
const AUTHOR_LINE = `${OWNER_LOGIN} <${OWNER_LOGIN}@example.invalid> ${FIXED_EPOCH_SEC} +0000`;

function computeNowIso(): string {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return FALLBACK_NOW;
}
const NOW_ISO = computeNowIso();

export function nowIso(): string {
  return NOW_ISO;
}

function userJson(): { login: string; id: number } {
  return { login: OWNER_LOGIN, id: OWNER_ID };
}

export class Store {
  repos: Map<string, Repo> = new Map();
  repoSeq = 1;
  issueIdSeq = 1;
  pullIdSeq = 1;
  commentIdSeq = 1;
  requestSeq = 0;
  token: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  nowIso(): string {
    return NOW_ISO;
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  createRepo(name: string, opts: { description?: string | null; private?: boolean; default_branch?: string }): Repo {
    const repo: Repo = {
      id: this.repoSeq,
      name,
      ownerLogin: OWNER_LOGIN,
      description: opts.description ?? null,
      default_branch: opts.default_branch ?? 'main',
      private: opts.private ?? false,
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      contents: new Map(),
      issueSeq: 1,
      prSeq: 1,
      issueByNumber: new Map(),
      pullByNumber: new Map(),
      issueComments: new Map(),
    };
    this.repoSeq += 1;
    this.repos.set(`${OWNER_LOGIN}/${name}`, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== OWNER_LOGIN) return undefined;
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== OWNER_LOGIN) return false;
    return this.repos.delete(`${owner}/${name}`);
  }

  createIssue(repo: Repo, title: string, body: string | null, labels: string[]): Issue {
    const issue: Issue = {
      id: this.issueIdSeq,
      number: repo.issueSeq,
      title,
      body,
      state: 'open',
      labels: [...labels],
      user: userJson(),
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
      closed_at: null,
      comments: 0,
    };
    this.issueIdSeq += 1;
    repo.issueSeq += 1;
    repo.issues.push(issue);
    repo.issueByNumber.set(issue.number, issue);
    return issue;
  }

  getIssue(repo: Repo, n: number): Issue | undefined {
    return repo.issueByNumber.get(n);
  }

  createPull(repo: Repo, title: string, body: string | null, headRef: string, baseRef: string): Pull {
    const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? '';
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? '';
    const pull: Pull = {
      id: this.pullIdSeq,
      number: repo.prSeq,
      title,
      body,
      state: 'open',
      merged: false,
      mergeable: true,
      head: { label: `${OWNER_LOGIN}:${headRef}`, ref: headRef, sha: headSha },
      base: { label: `${OWNER_LOGIN}:${baseRef}`, ref: baseRef, sha: baseSha },
      user: userJson(),
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
      merged_at: null,
      merge_commit_sha: null,
    };
    this.pullIdSeq += 1;
    repo.prSeq += 1;
    repo.pulls.push(pull);
    repo.pullByNumber.set(pull.number, pull);
    return pull;
  }

  getPull(repo: Repo, n: number): Pull | undefined {
    return repo.pullByNumber.get(n);
  }

  mergePull(repo: Repo, pr: Pull): { sha: string; message: string } | null {
    if (pr.state !== 'open' || pr.merged) return null;
    const baseRef = `refs/heads/${pr.base.ref}`;
    const headRef = `refs/heads/${pr.head.ref}`;
    const baseSha = repo.refs.get(baseRef);
    const headSha = repo.refs.get(headRef);
    if (baseSha === undefined || headSha === undefined || baseSha === '' || headSha === '') return null;
    // head 已合入（head 是 base 的祖先，或两者相同）→ 无事可合，视为冲突。
    if (isAncestor(repo.objects, headSha, baseSha)) return null;
    const headObj = repo.objects.get(headSha);
    if (headObj === undefined || headObj.type !== 'commit') return null;
    const headTree = parseCommit(headObj.data).tree;
    // 冲突检测：相对 merge-base，双方改了同一路径且结果 blob 不同。
    const baseCommit = mergeBase(repo, baseSha, headSha);
    if (baseCommit !== null) {
      const baseFiles = treeFileMap(repo, baseCommit);
      const headFiles = treeFileMap(repo, headSha);
      const curFiles = treeFileMap(repo, baseSha);
      const changedBoth = new Set<string>();
      for (const [path, entry] of headFiles) {
        const b = baseFiles.get(path);
        if ((b === undefined && entry !== undefined) || (b !== undefined && b.sha !== entry.sha)) changedBoth.add(path);
      }
      for (const path of baseFiles.keys()) {
        if (!headFiles.has(path)) changedBoth.add(path);
      }
      for (const path of changedBoth) {
        const b = baseFiles.get(path);
        const h = headFiles.get(path);
        const c = curFiles.get(path);
        const headChanged = (b === undefined && h !== undefined) || (b !== undefined && (h === undefined || h.sha !== b.sha));
        const curChanged = (b === undefined && c !== undefined) || (b !== undefined && (c === undefined || c.sha !== b.sha));
        if (headChanged && curChanged) {
          const hSha = h === undefined ? '' : h.sha;
          const cSha = c === undefined ? '' : c.sha;
          if (hSha !== cSha) return null;
        }
      }
    }
    const message = `Merge pull request #${pr.number} from ${pr.head.label}\n\n${pr.title}`;
    const commitData = formatCommit(headTree, [baseSha], AUTHOR_LINE, AUTHOR_LINE, message);
    const sha = storeObject(repo.objects, 'commit', commitData);
    repo.refs.set(baseRef, sha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergeable = false;
    pr.merged_at = NOW_ISO;
    pr.updated_at = NOW_ISO;
    pr.merge_commit_sha = sha;
    syncContentsFromTree(repo);
    return { sha, message };
  }
}

/** 两提交的最近公共祖先（沿 base 一侧回溯，遇到的第一个 head 祖先）；无则 null。 */
export function mergeBase(repo: Repo, aSha: string, bSha: string): string | null {
  const ancestorsA = new Set<string>();
  const stack: string[] = [aSha];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (ancestorsA.has(cur)) continue;
    ancestorsA.add(cur);
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  const stackB: string[] = [bSha];
  const seenB = new Set<string>();
  while (stackB.length > 0) {
    const cur = stackB.pop() as string;
    if (ancestorsA.has(cur)) return cur;
    if (seenB.has(cur)) continue;
    seenB.add(cur);
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stackB.push(p);
  }
  return null;
}

/** 提交 sha → 其树根下所有文件 {path → {sha, content}}（递归展开嵌套树）。 */
export function treeFileMap(repo: Repo, commitSha: string): Map<string, { sha: string; content: Buffer }> {
  const out = new Map<string, { sha: string; content: Buffer }>();
  const commit = repo.objects.get(commitSha);
  if (commit === undefined || commit.type !== 'commit') return out;
  const treeSha = parseCommit(commit.data).tree;
  walkTree(repo, treeSha, '', out);
  return out;
}

function walkTree(repo: Repo, treeSha: string, prefix: string, out: Map<string, { sha: string; content: Buffer }>): void {
  const obj = repo.objects.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      walkTree(repo, entry.sha, path, out);
    } else {
      const blob = repo.objects.get(entry.sha);
      if (blob !== undefined) out.set(path, { sha: entry.sha, content: blob.data });
    }
  }
}

/** 把文件 map 建成嵌套树并落库，返回根树 sha。 */
export function buildTreeForFiles(repo: Repo, files: Map<string, Buffer>): string {
  // 按目录分组：自底向上建树；先把每个文件目录的所有祖先目录都登记进来，
  // 否则只有子目录、没有直接文件的中间目录会丢。
  const byDir = new Map<string, Map<string, { mode: string; name: string; sha: string }>>();
  const ensureDir = (dir: string): Map<string, { mode: string; name: string; sha: string }> => {
    let m = byDir.get(dir);
    if (m === undefined) {
      m = new Map();
      byDir.set(dir, m);
    }
    return m;
  };
  ensureDir('');
  for (const [path, content] of files) {
    const blobSha = storeObject(repo.objects, 'blob', content);
    const slash = path.lastIndexOf('/');
    const dir = slash === -1 ? '' : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    ensureDir(dir).set(name, { mode: '100644', name, sha: blobSha });
    // 登记全部祖先目录。
    let d = dir;
    while (d !== '') {
      const s = d.lastIndexOf('/');
      d = s === -1 ? '' : d.slice(0, s);
      ensureDir(d);
    }
  }
  // 目录按深度倒序处理，保证子树先落库。
  const dirs = [...byDir.keys()].sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? 1 : -1));
  const dirTreeSha = new Map<string, string>();
  for (const dir of dirs) {
    const entries = [...(byDir.get(dir) as Map<string, { mode: string; name: string; sha: string }>).values()];
    for (const [sub, sha] of dirTreeSha) {
      const slash = sub.lastIndexOf('/');
      const parent = slash === -1 ? '' : sub.slice(0, slash);
      if (parent === dir) {
        const name = slash === -1 ? sub : sub.slice(slash + 1);
        entries.push({ mode: '40000', name, sha });
      }
    }
    const treeSha = storeObject(repo.objects, 'tree', formatTree(entries));
    dirTreeSha.set(dir, treeSha);
  }
  return dirTreeSha.get('') as string;
}

/**
 * 在分支上用给定文件集提交一次（文件集即该分支提交后的完整树）。
 * 返回新 commit sha；同时更新 refs；若是默认分支则同步 repo.contents。
 */
export function commitFiles(repo: Repo, branch: string, files: Map<string, Buffer>, message: string): string {
  const treeSha = buildTreeForFiles(repo, files);
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const parents = parent !== undefined && parent !== '' ? [parent] : [];
  const commitData = formatCommit(treeSha, parents, AUTHOR_LINE, AUTHOR_LINE, message);
  const sha = storeObject(repo.objects, 'commit', commitData);
  repo.refs.set(ref, sha);
  if (branch === repo.default_branch) syncContentsFromTree(repo);
  return sha;
}

/** 用默认分支头树重建 repo.contents（默认分支快照，供视图/兼容使用）。 */
export function syncContentsFromTree(repo: Repo): void {
  const head = repo.refs.get(`refs/heads/${repo.default_branch}`);
  repo.contents.clear();
  if (head === undefined) return;
  for (const [path, entry] of treeFileMap(repo, head)) {
    repo.contents.set(path, { path, sha: entry.sha, content: entry.content, message: '' });
  }
}

/** 解析 "Name <email> ts tz" 形式的 author/committer 行。 */
export function parseIdentity(line: string): { name: string; email: string; date: string } {
  const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (m === null) return { name: line, email: '', date: NOW_ISO };
  return { name: m[1] as string, email: m[2] as string, date: new Date(Number(m[3]) * 1000).toISOString() };
}

// -------------------------------------------------------------------------------------------
// JSON 视图

function baseUrlOf(repo: Repo): string {
  return `https://api.github.com/repos/${OWNER_LOGIN}/${repo.name}`;
}

export function repoJson(repo: Repo): any {
  const openIssues = repo.issues.filter((i) => i.state === 'open').length + repo.pulls.filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${OWNER_LOGIN}/${repo.name}`,
    owner: { login: OWNER_LOGIN, id: OWNER_ID, type: 'User', site_admin: false, avatar_url: `https://avatars.githubusercontent.com/u/${OWNER_ID}?v=4`, html_url: `https://github.com/${OWNER_LOGIN}`, url: `https://api.github.com/users/${OWNER_LOGIN}` },
    private: repo.private,
    html_url: `https://github.com/${OWNER_LOGIN}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: baseUrlOf(repo),
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
    git_url: `git://github.com/${OWNER_LOGIN}/${repo.name}.git`,
    ssh_url: `git@github.com:${OWNER_LOGIN}/${repo.name}.git`,
    clone_url: `https://github.com/${OWNER_LOGIN}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.default_branch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    topics: [],
  };
}

export function labelJson(label: Label): any {
  return { name: label.name, color: label.color, description: label.description, url: '', default: false };
}

export function issueJson(repo: Repo, issue: Issue): any {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    url: `${baseUrlOf(repo)}/issues/${issue.number}`,
    repository_url: baseUrlOf(repo),
    labels_url: `${baseUrlOf(repo)}/issues/${issue.number}/labels{/name}`,
    comments_url: `${baseUrlOf(repo)}/issues/${issue.number}/comments`,
    events_url: `${baseUrlOf(repo)}/issues/${issue.number}/events`,
    html_url: `https://github.com/${OWNER_LOGIN}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: issue.user.login, id: issue.user.id, type: 'User', avatar_url: `https://avatars.githubusercontent.com/u/${issue.user.id}?v=4`, html_url: `https://github.com/${issue.user.login}` },
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return l !== undefined ? labelJson(l) : { name, color: 'ededed', description: '' };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    author_association: 'OWNER',
    state_reason: null,
  };
}

export function pullJson(repo: Repo, pr: Pull): any {
  const user = { login: pr.user.login, id: pr.user.id, type: 'User', avatar_url: `https://avatars.githubusercontent.com/u/${pr.user.id}?v=4`, html_url: `https://github.com/${pr.user.login}` };
  const repoMini = { id: repo.id, name: repo.name, full_name: `${OWNER_LOGIN}/${repo.name}`, owner: { login: OWNER_LOGIN, id: OWNER_ID, type: 'User' }, private: repo.private, html_url: `https://github.com/${OWNER_LOGIN}/${repo.name}`, description: repo.description, default_branch: repo.default_branch };
  return {
    id: pr.id,
    node_id: `PR_${pr.id}`,
    url: `${baseUrlOf(repo)}/pulls/${pr.number}`,
    html_url: `https://github.com/${OWNER_LOGIN}/${repo.name}/pull/${pr.number}`,
    diff_url: `https://github.com/${OWNER_LOGIN}/${repo.name}/pull/${pr.number}.diff`,
    patch_url: `https://github.com/${OWNER_LOGIN}/${repo.name}/pull/${pr.number}.patch`,
    issue_url: `${baseUrlOf(repo)}/issues/${pr.number}`,
    number: pr.number,
    state: pr.state,
    locked: false,
    title: pr.title,
    body: pr.body,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.state === 'closed' ? (pr.merged_at ?? pr.updated_at) : null,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    author_association: 'OWNER',
    user,
    labels: [],
    milestone: null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    head: { label: pr.head.label, ref: pr.head.ref, sha: pr.head.sha, user, repo: repoMini },
    base: { label: pr.base.label, ref: pr.base.ref, sha: pr.base.sha, user, repo: repoMini },
    merged: pr.merged,
    mergeable: pr.mergeable,
    mergeable_state: pr.merged ? 'merged' : 'clean',
    merged_by: pr.merged ? user : null,
    draft: false,
  };
}
