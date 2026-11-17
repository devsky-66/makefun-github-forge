// GraphQL v4 (/api/graphql) handler for github-core-clone-01.
// Hand-written minimal GraphQL executor: no npm packages, stdlib only.
// Reads checks-graphql.ts / graphql-client.ts as the contract:
//   viewer, repository(+issue/issues/pullRequest/pullRequests), node(id:),
//   __type/__schema introspection, createIssue/closeIssue/createPullRequest/
//   mergePullRequest/addComment mutations, batched operation arrays.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  return handleGraphqlInner(req, res, store);
}

// ---------------------------------------------------------------------------
// Minimal structural views of the store (duck-typed so this file only depends
// on the Store surface the task states, not on extra exports).
// ---------------------------------------------------------------------------
interface RepoLike {
  id: number;
  name: string;
  ownerLogin: string;
  description: string | null;
  default_branch: string;
  private: boolean;
  created_at: string;
  updated_at: string;
  refs: Map<string, string>;
  objects: Map<string, { type: string; data: Buffer }>;
  labels: Map<string, unknown>;
  issues: IssueLike[];
  pulls: PullLike[];
  contents: Map<string, unknown>;
  issueSeq: number;
  prSeq: number;
  issueByNumber: Map<number, IssueLike>;
  pullByNumber: Map<number, PullLike>;
  [key: string]: unknown;
}
interface IssueLike {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: number;
  [key: string]: unknown;
}
interface PullLike {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean | null;
  head: { label: string; ref: string; sha: string };
  base: { label: string; ref: string; sha: string };
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  [key: string]: unknown;
}
type StoreLike = {
  repos: Map<string, RepoLike>;
  token: string;
  nowIso(): string;
  nextRequestId(): string;
  createRepo(name: string, opts: { description?: string | null; private?: boolean }): RepoLike;
  getRepo(owner: string, name: string): RepoLike | undefined;
  deleteRepo(owner: string, name: string): boolean;
  createIssue(repo: RepoLike, title: string, body: string | null, labels: string[]): IssueLike;
  getIssue(repo: RepoLike, n: number): IssueLike | undefined;
  createPull(repo: RepoLike, title: string, body: string | null, headRef: string, baseRef: string): PullLike;
  getPull(repo: RepoLike, n: number): PullLike | undefined;
  mergePull(repo: RepoLike, pr: PullLike): { sha: string; message: string } | null;
};

// ---------------------------------------------------------------------------
// Global (Relay) ids: opaque, deterministic, reversible.
//   Repository R_<dbid>   Issue I_<repoDbId>_<number>   PullRequest PR_<repoDbId>_<number>
//   Comment   IC_<repoDbId>_<issueNumber>_<seq>
// ---------------------------------------------------------------------------
function repoGlobalId(repo: RepoLike): string { return `R_${repo.id}`; }
// Same spelling as the store's REST node_id values (repoJson/issueJson/pullJson):
//   Issue I_<issue.id> (the store-global issue id), PullRequest PR_<pr.id>.
function issueGlobalId(repo: RepoLike, issue: IssueLike): string { return `I_${issue.id}`; }
function pullGlobalId(repo: RepoLike, pr: PullLike): string { return `PR_${pr.id}`; }
function commentGlobalId(seq: number): string { return `IC_${seq}`; }

function findRepoByDbId(store: StoreLike, dbId: number): RepoLike | undefined {
  for (const repo of store.repos.values()) if (repo.id === dbId) return repo;
  return undefined;
}
function findRepoByGlobalId(store: StoreLike, id: string): RepoLike | undefined {
  const m = /^R_(\d+)$/.exec(id);
  if (m !== null) return findRepoByDbId(store, Number(m[1]));
  if (/^\d+$/.test(id)) return findRepoByDbId(store, Number(id));
  const slash = id.indexOf('/');
  if (slash > 0) return store.getRepo(id.slice(0, slash), id.slice(slash + 1)) as RepoLike | undefined;
  return undefined;
}
function findIssueByGlobalId(store: StoreLike, id: string): { repo: RepoLike; issue: IssueLike } | undefined {
  const m = /^I_(\d+)_(\d+)$/.exec(id);
  if (m !== null) {
    const repo = findRepoByDbId(store, Number(m[1]));
    const issue = repo?.issueByNumber.get(Number(m[2]));
    if (repo !== undefined && issue !== undefined) return { repo, issue };
    return undefined;
  }
  const n = /^I_(\d+)$/.exec(id);
  if (n !== null) {
    for (const repo of store.repos.values()) for (const issue of repo.issues) if (issue.id === Number(n[1])) return { repo, issue };
  }
  return undefined;
}
function findPullByGlobalId(store: StoreLike, id: string): { repo: RepoLike; pr: PullLike } | undefined {
  const m = /^PR_(\d+)_(\d+)$/.exec(id);
  if (m !== null) {
    const repo = findRepoByDbId(store, Number(m[1]));
    const pr = repo?.pullByNumber.get(Number(m[2]));
    if (repo !== undefined && pr !== undefined) return { repo, pr };
    return undefined;
  }
  const n = /^PR_(\d+)$/.exec(id);
  if (n !== null) {
    for (const repo of store.repos.values()) for (const pr of repo.pulls) if (pr.id === Number(n[1])) return { repo, pr };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Introspection tables (the __type surface gh feature-detects).
// ---------------------------------------------------------------------------
interface TypeRef { kind: string; name: string | null; ofType: TypeRef | null }
function ref(kind: string, name: string | null = null, ofType: TypeRef | null = null): TypeRef { return { kind, name, ofType }; }
function nonNull(inner: TypeRef): TypeRef { return ref('NON_NULL', null, inner); }
function listOf(inner: TypeRef): TypeRef { return ref('LIST', null, inner); }
const ID = ref('SCALAR', 'ID');
const STR = ref('SCALAR', 'String');
const INT = ref('SCALAR', 'Int');
const BOOL = ref('SCALAR', 'Boolean');
const OBJ = (name: string): TypeRef => ref('OBJECT', name);
const EN = (name: string): TypeRef => ref('ENUM', name);

interface FieldDef { name: string; type: TypeRef }
interface TypeDef { kind: string; fields: FieldDef[]; enumValues: string[] }
function fieldsOf(...pairs: Array<[string, TypeRef]>): FieldDef[] {
  return pairs.map(([name, type]) => ({ name, type }));
}
const TYPE_DEFS: Record<string, TypeDef> = {
  Query: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['viewer', OBJ('User')], ['repository', OBJ('Repository')], ['node', OBJ('Node')], ['search', OBJ('SearchResultItemConnection')], ['__type', OBJ('__Type')], ['__schema', OBJ('__Schema')]) },
  Mutation: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['createIssue', OBJ('CreateIssuePayload')], ['closeIssue', OBJ('CloseIssuePayload')], ['createPullRequest', OBJ('CreatePullRequestPayload')], ['mergePullRequest', OBJ('MergePullRequestPayload')], ['addComment', OBJ('AddCommentPayload')]) },
  Repository: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['id', nonNull(ID)], ['databaseId', INT], ['name', STR], ['nameWithOwner', STR], ['description', STR], ['owner', OBJ('User')], ['defaultBranchRef', OBJ('Ref')], ['viewerPermission', EN('RepositoryPermission')], ['hasIssuesEnabled', BOOL], ['isPrivate', BOOL], ['createdAt', STR], ['updatedAt', STR], ['url', STR], ['issue', OBJ('Issue')], ['issues', OBJ('IssueConnection')], ['pullRequests', OBJ('PullRequestConnection')], ['pullRequest', OBJ('PullRequest')]) },
  Issue: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['id', nonNull(ID)], ['number', INT], ['title', STR], ['body', STR], ['state', EN('IssueState')], ['createdAt', STR], ['updatedAt', STR], ['closedAt', STR], ['author', OBJ('User')], ['labels', OBJ('LabelConnection')], ['comments', OBJ('IssueCommentConnection')], ['url', STR]) },
  PullRequest: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['id', nonNull(ID)], ['number', INT], ['title', STR], ['body', STR], ['state', EN('PullRequestState')], ['merged', BOOL], ['mergeable', EN('MergeableState')], ['headRefName', STR], ['baseRefName', STR], ['headRef', OBJ('Ref')], ['baseRef', OBJ('Ref')], ['files', OBJ('PullRequestChangedFileConnection')], ['author', OBJ('User')], ['createdAt', STR], ['updatedAt', STR], ['mergedAt', STR], ['url', STR], ['additions', INT], ['deletions', INT], ['changedFiles', INT]) },
  User: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['id', nonNull(ID)], ['login', STR], ['name', STR], ['email', STR], ['url', STR]) },
  Ref: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['name', STR], ['prefix', STR]) },
  IssueConnection: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['nodes', listOf(OBJ('Issue'))], ['edges', listOf(OBJ('IssueEdge'))], ['totalCount', INT], ['pageInfo', OBJ('PageInfo')]) },
  PullRequestConnection: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['nodes', listOf(OBJ('PullRequest'))], ['edges', listOf(OBJ('PullRequestEdge'))], ['totalCount', INT], ['pageInfo', OBJ('PageInfo')]) },
  PullRequestChangedFileConnection: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['nodes', listOf(OBJ('PullRequestChangedFile'))], ['edges', listOf(OBJ('PullRequestChangedFileEdge'))], ['totalCount', INT], ['pageInfo', OBJ('PageInfo')]) },
  SearchResultItemConnection: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['nodes', listOf(OBJ('Issue'))], ['edges', listOf(OBJ('SearchResultItemEdge'))], ['totalCount', INT], ['issueCount', INT], ['pageInfo', OBJ('PageInfo')]) },
  LabelConnection: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['nodes', listOf(OBJ('Label'))], ['edges', listOf(OBJ('LabelEdge'))], ['totalCount', INT], ['pageInfo', OBJ('PageInfo')]) },
  IssueCommentConnection: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['nodes', listOf(OBJ('IssueComment'))], ['edges', listOf(OBJ('IssueCommentEdge'))], ['totalCount', INT], ['pageInfo', OBJ('PageInfo')]) },
  IssueEdge: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['node', OBJ('Issue')], ['cursor', STR]) },
  PullRequestEdge: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['node', OBJ('PullRequest')], ['cursor', STR]) },
  PullRequestChangedFileEdge: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['node', OBJ('PullRequestChangedFile')], ['cursor', STR]) },
  SearchResultItemEdge: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['node', OBJ('Issue')], ['cursor', STR]) },
  LabelEdge: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['node', OBJ('Label')], ['cursor', STR]) },
  IssueCommentEdge: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['node', OBJ('IssueComment')], ['cursor', STR]) },
  PullRequestChangedFile: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['path', STR], ['additions', INT], ['deletions', INT], ['changeType', STR]) },
  Label: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['id', nonNull(ID)], ['name', STR], ['description', STR], ['color', STR]) },
  IssueComment: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['id', nonNull(ID)], ['body', STR], ['author', OBJ('User')], ['createdAt', STR]) },
  PageInfo: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['hasNextPage', BOOL], ['hasPreviousPage', BOOL], ['startCursor', STR], ['endCursor', STR]) },
  CreateIssuePayload: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['issue', OBJ('Issue')], ['clientMutationId', STR]) },
  CloseIssuePayload: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['issue', OBJ('Issue')], ['clientMutationId', STR]) },
  CreatePullRequestPayload: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['pullRequest', OBJ('PullRequest')], ['clientMutationId', STR]) },
  MergePullRequestPayload: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['pullRequest', OBJ('PullRequest')], ['clientMutationId', STR]) },
  AddCommentPayload: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['commentEdge', OBJ('IssueCommentEdge')], ['clientMutationId', STR]) },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'], fields: [] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'], fields: [] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'], fields: [] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'], fields: [] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'], fields: [] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'], fields: [] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'], fields: [] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'], fields: [] },
  __Type: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['name', STR], ['kind', STR], ['description', STR], ['fields', listOf(OBJ('__Field'))], ['enumValues', listOf(OBJ('__EnumValue'))], ['inputFields', listOf(OBJ('__InputValue'))], ['interfaces', listOf(OBJ('__Type'))], ['possibleTypes', listOf(OBJ('__Type'))], ['ofType', OBJ('__Type')]) },
  __Field: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['name', STR], ['description', STR], ['args', listOf(OBJ('__InputValue'))], ['type', OBJ('__Type')], ['isDeprecated', BOOL], ['deprecationReason', STR]) },
  __EnumValue: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['name', STR], ['description', STR], ['isDeprecated', BOOL], ['deprecationReason', STR]) },
  __InputValue: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['name', STR], ['description', STR], ['type', OBJ('__Type')], ['defaultValue', STR]) },
  __Schema: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['queryType', OBJ('__Type')], ['mutationType', OBJ('__Type')], ['subscriptionType', OBJ('__Type')], ['types', listOf(OBJ('__Type'))], ['directives', listOf(OBJ('__Directive'))]) },
  __Directive: { kind: 'OBJECT', enumValues: [], fields: fieldsOf(['name', STR], ['description', STR], ['locations', listOf(STR)], ['args', listOf(OBJ('__InputValue'))]) },
  Node: { kind: 'INTERFACE', enumValues: [], fields: fieldsOf(['id', nonNull(ID)]) },
};
const KNOWN_FIELDS: Record<string, Set<string>> = {};
for (const [name, def] of Object.entries(TYPE_DEFS)) KNOWN_FIELDS[name] = new Set(def.fields.map((f) => f.name));

// ---------------------------------------------------------------------------
// Lexer / parser for the GraphQL document subset the suite sends.
// ---------------------------------------------------------------------------
type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: '' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  const isDigit = (c: string): boolean => /[0-9]/.test(c);
  while (i < input.length) {
    const c = input[i] ?? '';
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\uFEFF') { i += 1; continue; }
    if (c === '#') { while (i < input.length && input[i] !== '\n') i += 1; continue; }
    if (c === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(i + 3, end).replace(/\\"""/g, '"""') });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        const ch = input[j] ?? '';
        if (ch === '\\') {
          const esc = input[j + 1] ?? '';
          if (esc === 'u') { out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16)); j += 6; continue; }
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          out += map[esc] ?? esc;
          j += 2;
          continue;
        }
        out += ch;
        j += 1;
      }
      if (j >= input.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || isDigit(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && isDigit(input[j] ?? '')) j += 1;
      let isFloat = false;
      if (input[j] === '.' && isDigit(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && isDigit(input[j] ?? '')) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        let k = j + 1;
        if (input[k] === '+' || input[k] === '-') k += 1;
        if (isDigit(input[k] ?? '')) {
          isFloat = true;
          j = k;
          while (j < input.length && isDigit(input[j] ?? '')) j += 1;
        }
      }
      tokens.push(isFloat ? { kind: 'float', value: input.slice(i, j) } : { kind: 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j] ?? '')) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (input.startsWith('...', i)) { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('!$():=@[]{}|&'.includes(c)) { tokens.push({ kind: 'punct', value: c }); i += 1; continue; }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };
interface DirectiveNode { name: string; args: Array<{ name: string; value: ValueNode }> }
interface FieldNode { kind: 'field'; alias: string | null; name: string; args: Array<{ name: string; value: ValueNode }>; directives: DirectiveNode[]; selectionSet: SelectionNode[] | null }
interface SpreadNode { kind: 'spread'; name: string; directives: DirectiveNode[] }
interface InlineNode { kind: 'inline'; typeCondition: string | null; directives: DirectiveNode[]; selectionSet: SelectionNode[] }
type SelectionNode = FieldNode | SpreadNode | InlineNode;
interface OperationNode { kind: 'operation'; operation: 'query' | 'mutation' | 'subscription'; name: string | null; variables: Array<{ name: string; defaultValue: ValueNode | null }>; directives: DirectiveNode[]; selectionSet: SelectionNode[] }
interface FragmentNode { kind: 'fragment'; name: string; typeCondition: string; directives: DirectiveNode[]; selectionSet: SelectionNode[] }
type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }
  peek(): Token { return this.tokens[this.pos] ?? { kind: 'eof', value: '' }; }
  next(): Token { const t = this.tokens[this.pos] ?? { kind: 'eof', value: '' }; this.pos += 1; return t; }
  expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected "${v}" but got ${t.kind} ${JSON.stringify(t.value)}`);
  }
  expectName(v?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected a name but got ${t.kind} ${JSON.stringify(t.value)}`);
    if (v !== undefined && t.value !== v) throw new Error(`expected "${v}" but got "${t.value}"`);
    return t.value;
  }
  isPunct(v: string): boolean { const t = this.peek(); return t.kind === 'punct' && t.value === v; }
  parseDocument(): DefinitionNode[] {
    const defs: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') defs.push(this.parseDefinition());
    return defs;
  }
  parseDefinition(): DefinitionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '{') return { kind: 'operation', operation: 'query', name: null, variables: [], directives: [], selectionSet: this.parseSelectionSet() };
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      this.next();
      const op = t.value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value as string;
      const variables = this.isPunct('(') ? this.parseVariableDefinitions() : [];
      const directives = this.parseDirectives();
      return { kind: 'operation', operation: op, name, variables, directives, selectionSet: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      const directives = this.parseDirectives();
      return { kind: 'fragment', name, typeCondition, directives, selectionSet: this.parseSelectionSet() };
    }
    throw new Error(`unexpected token ${t.kind} ${JSON.stringify(t.value)} at document top level`);
  }
  parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const out: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.isPunct('=')) { this.next(); defaultValue = this.parseValue(true); }
      out.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return out;
  }
  parseType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.isPunct('!')) this.next();
  }
  parseDirectives(): DirectiveNode[] {
    const out: DirectiveNode[] = [];
    while (this.isPunct('@')) {
      this.next();
      const name = this.expectName();
      const args = this.isPunct('(') ? this.parseArguments() : [];
      out.push({ name, args });
    }
    return out;
  }
  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }
  parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.next();
      const t = this.peek();
      if (t.kind === 'name' && t.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        return { kind: 'inline', typeCondition, directives, selectionSet: this.parseSelectionSet() };
      }
      if (t.kind === 'name') {
        const name = this.next().value as string;
        const directives = this.parseDirectives();
        return { kind: 'spread', name, directives };
      }
      const directives = this.parseDirectives();
      return { kind: 'inline', typeCondition: null, directives, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.isPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.isPunct('(') ? this.parseArguments() : [];
    const directives = this.parseDirectives();
    const selectionSet = this.isPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }
  parseArguments(): Array<{ name: string; value: ValueNode }> {
    const out: Array<{ name: string; value: ValueNode }> = [];
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      out.push({ name, value: this.parseValue(false) });
    }
    this.expectPunct(')');
    return out;
  }
  parseValue(isConst: boolean): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      if (isConst) throw new Error('variable in constant value');
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue(isConst));
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${t.kind} ${JSON.stringify(t.value)}`);
  }
}
function parseDocument(query: string): DefinitionNode[] {
  return new Parser(lex(query)).parseDocument();
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------
class GqlError extends Error {}
interface ExecCtx {
  store: StoreLike;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}
type AnyObj = Record<string, unknown>;

// Wrapper values carry __type so nested selection sets know their type.
function wrap(type: string, extra: Record<string, unknown>): AnyObj { return { __type: type, ...extra }; }
function typeOfValue(v: unknown): string | null {
  if (v !== null && typeof v === 'object' && typeof (v as AnyObj).__type === 'string') return (v as AnyObj).__type as string;
  return null;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'int': case 'float': case 'string': case 'boolean': case 'enum': return node.value;
    case 'null': return null;
    case 'list': return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}
function argsOf(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveValue(a.value, ctx.variables);
  return out;
}
function directivesSkip(directives: DirectiveNode[], ctx: ExecCtx): boolean {
  for (const d of directives) {
    const args: Record<string, unknown> = {};
    for (const a of d.args) args[a.name] = resolveValue(a.value, ctx.variables);
    if (d.name === 'skip' && args.if === true) return true;
    if (d.name === 'include' && args.if === false) return true;
  }
  return false;
}

function executeSelectionSet(selections: SelectionNode[], parent: unknown, parentType: string, ctx: ExecCtx, path: Array<string | number>): AnyObj {
  const out: AnyObj = {};
  const known = KNOWN_FIELDS[parentType];
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      if (directivesSkip(sel.directives, ctx)) continue;
      const frag = ctx.fragments.get(sel.name);
      if (frag === undefined) { ctx.errors.push({ message: `Unknown fragment "${sel.name}".`, path }); continue; }
      if (frag.typeCondition !== parentType && frag.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelectionSet(frag.selectionSet, parent, parentType, ctx, path));
      continue;
    }
    if (sel.kind === 'inline') {
      if (directivesSkip(sel.directives, ctx)) continue;
      if (sel.typeCondition !== null && sel.typeCondition !== parentType && sel.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelectionSet(sel.selectionSet, parent, parentType, ctx, path));
      continue;
    }
    if (directivesSkip(sel.directives, ctx)) continue;
    const responseKey = sel.alias ?? sel.name;
    const fieldPath = [...path, responseKey];
    if (sel.name === '__typename') { out[responseKey] = parentType; continue; }
    if (known !== undefined && !known.has(sel.name)) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${parentType}".`, path: fieldPath });
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(parent, parentType, sel, argsOf(sel, ctx), ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    if (sel.selectionSet !== null) {
      out[responseKey] = projectValue(value, sel.selectionSet, ctx, fieldPath);
    } else {
      out[responseKey] = stripWrapper(value);
    }
  }
  return out;
}

// Project a resolved value through a sub-selection set (object, list, or null).
function projectValue(value: unknown, selections: SelectionNode[], ctx: ExecCtx, path: Array<string | number>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item, i) => projectValue(item, selections, ctx, [...path, i]));
  const t = typeOfValue(value);
  if (t === null) {
    ctx.errors.push({ message: 'Field has a sub-selection but resolved to a scalar value.', path });
    return null;
  }
  return executeSelectionSet(selections, value, t, ctx, path);
}
function stripWrapper(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const rec = value as AnyObj;
    if (typeof rec.__type === 'string') {
      const out: AnyObj = {};
      for (const [k, v] of Object.entries(rec)) if (k !== '__type') out[k] = v;
      return out;
    }
  }
  return value;
}

function executeOperation(op: OperationNode, fragments: Map<string, FragmentNode>, store: StoreLike, variables: Record<string, unknown>): { data: unknown; errors: Array<{ message: string; path?: Array<string | number> }> } {
  const ctx: ExecCtx = { store, variables, fragments, errors: [] };
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const root = wrap(rootType, {});
  const data = executeSelectionSet(op.selectionSet, root, rootType, ctx, []);
  return { data, errors: ctx.errors };
}

function runDocument(query: string, variables: Record<string, unknown>, operationName: string | undefined, store: StoreLike): { data: unknown; errors: Array<{ message: string; path?: Array<string | number> }> } {
  let defs: DefinitionNode[];
  try {
    defs = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const ops: OperationNode[] = [];
  for (const d of defs) {
    if (d.kind === 'fragment') fragments.set(d.name, d);
    else ops.push(d);
  }
  if (ops.length === 0) return { data: null, errors: [{ message: 'No operation found in document.' }] };
  let op: OperationNode | undefined;
  if (operationName !== undefined) {
    op = ops.find((o) => o.name === operationName);
    if (op === undefined) return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
  } else if (ops.length === 1) {
    op = ops[0];
  } else {
    return { data: null, errors: [{ message: 'Multiple operations in one document require an operationName.' }] };
  }
  const vars: Record<string, unknown> = { ...variables };
  for (const v of op.variables) {
    if (!(v.name in vars) || vars[v.name] === undefined) {
      if (v.defaultValue !== null) vars[v.name] = resolveValue(v.defaultValue, vars);
    }
  }
  try {
    return executeOperation(op, fragments, store, vars);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

// ---------------------------------------------------------------------------
// Cursors: deterministic base64url of the issue/PR number the page ends on.
// ---------------------------------------------------------------------------
function encodeCursor(n: number): string { return Buffer.from(`cursor:${n}`).toString('base64url'); }
function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m !== null ? Number(m[1]) : null;
  } catch { return null; }
}
function pageInfo(hasNext: boolean, hasPrev: boolean, start: string | null, end: string | null): AnyObj {
  return wrap('PageInfo', { hasNextPage: hasNext, hasPreviousPage: hasPrev, startCursor: start, endCursor: end });
}
function edge(type: string, node: unknown, cursor: string): AnyObj { return wrap(type, { node, cursor }); }

function issueConnection(repo: RepoLike, issues: IssueLike[], first: number | undefined, after: unknown): AnyObj {
  // Preserve the caller's order (the resolver already applied orderBy).
  const sorted = issues.slice();
  const afterNum = decodeCursor(after);
  const afterIdx = afterNum !== null ? sorted.findIndex((i) => i.number === afterNum) : -1;
  const rest = afterIdx >= 0 ? sorted.slice(afterIdx + 1) : sorted;
  const page = first !== undefined ? rest.slice(0, first) : rest;
  const hasNext = first !== undefined && rest.length > first;
  const nodes = page.map((i) => wrap('Issue', { repo, issue: i }));
  const edges = page.map((i) => edge('IssueEdge', wrap('Issue', { repo, issue: i }), encodeCursor(i.number)));
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]?.number ?? 0) : null;
  const startCursor = page.length > 0 ? encodeCursor(page[0]?.number ?? 0) : null;
  return wrap('IssueConnection', { nodes, edges, totalCount: sorted.length, pageInfo: pageInfo(hasNext, afterIdx >= 0, startCursor, endCursor), _all: sorted });
}
function pullConnection(repo: RepoLike, pulls: PullLike[], first: number | undefined): AnyObj {
  const sorted = pulls.slice().sort((a, b) => a.number - b.number);
  const page = first !== undefined ? sorted.slice(0, first) : sorted;
  const nodes = page.map((p) => wrap('PullRequest', { repo, pr: p }));
  const edges = page.map((p) => edge('PullRequestEdge', wrap('PullRequest', { repo, pr: p }), encodeCursor(p.number)));
  return wrap('PullRequestConnection', { nodes, edges, totalCount: sorted.length, pageInfo: pageInfo(sorted.length > page.length, false, page.length > 0 ? encodeCursor(page[0]?.number ?? 0) : null, page.length > 0 ? encodeCursor(page[page.length - 1]?.number ?? 0) : null) });
}

// ---------------------------------------------------------------------------
// Pull-request changed files: diff the head tree against the base tree.
// Falls back to a `files` field on the pull object when the store carries one.
// ---------------------------------------------------------------------------
function hexOf(bytes: Buffer): string { return bytes.toString('hex'); }
function commitTreeSha(store: StoreLike, repo: RepoLike, commitSha: string): string | null {
  const obj = repo.objects.get(commitSha);
  if (obj === undefined) return null;
  const text = obj.data.toString('utf8');
  const m = /^tree ([0-9a-f]{40})$/m.exec(text);
  return m !== null ? m[1] ?? null : null;
}
function walkTree(store: StoreLike, repo: RepoLike, treeSha: string, prefix: string, out: Map<string, string>): void {
  const obj = repo.objects.get(treeSha);
  if (obj === undefined) return;
  const data = obj.data;
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = data.subarray(i, sp).toString('utf8');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const sha = hexOf(data.subarray(nul + 1, nul + 21));
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (mode === '40000') walkTree(store, repo, sha, path, out);
    else out.set(path, sha);
    i = nul + 21;
  }
}
function prChangedPaths(store: StoreLike, repo: RepoLike, pr: PullLike): string[] {
  const raw = (pr as AnyObj).files;
  if (Array.isArray(raw)) {
    const paths: string[] = [];
    for (const f of raw) {
      if (typeof f === 'string') paths.push(f);
      else if (f !== null && typeof f === 'object') {
        const r = f as AnyObj;
        if (typeof r.path === 'string') paths.push(r.path);
        else if (typeof r.filename === 'string') paths.push(r.filename);
      }
    }
    if (paths.length > 0) return paths.slice().sort();
  }
  const baseSha = repo.refs.get(`refs/heads/${pr.base.ref}`);
  const headSha = repo.refs.get(`refs/heads/${pr.head.ref}`);
  if (baseSha === undefined || headSha === undefined) return [];
  const baseTree = commitTreeSha(store, repo, baseSha);
  const headTree = commitTreeSha(store, repo, headSha);
  if (baseTree === null || headTree === null) return [];
  const baseMap = new Map<string, string>();
  const headMap = new Map<string, string>();
  walkTree(store, repo, baseTree, '', baseMap);
  walkTree(store, repo, headTree, '', headMap);
  const changed: string[] = [];
  for (const [path, sha] of headMap) if (baseMap.get(path) !== sha) changed.push(path);
  for (const path of baseMap.keys()) if (!headMap.has(path)) changed.push(path);
  return changed.sort();
}

// ---------------------------------------------------------------------------
// Comments: persist through the store when it offers a comment API, else keep
// a process-local fallback (GraphQL echo still works; the REST cross-read
// needs the store's own comment storage, which the REST group owns).
// ---------------------------------------------------------------------------
const LOCAL_COMMENTS = new Map<string, Array<{ id: string; body: string; authorLogin: string; createdAt: string }>>();
function localCommentKey(repo: RepoLike, issue: IssueLike): string { return `${repo.id}:${issue.number}`; }
function readLocalComments(repo: RepoLike, issue: IssueLike): Array<{ id: string; body: string; authorLogin: string; createdAt: string }> {
  return LOCAL_COMMENTS.get(localCommentKey(repo, issue)) ?? [];
}
function addCommentToStore(store: StoreLike, repo: RepoLike, issue: IssueLike, body: string): { id: string; body: string } {
  const s = store as unknown as Record<string, unknown>;
  const candidates: Array<(...a: never[]) => unknown> = [];
  for (const key of ['addComment', 'createComment', 'addIssueComment', 'createIssueComment']) {
    const fn = s[key];
    if (typeof fn === 'function') candidates.push(fn as (...a: never[]) => unknown);
  }
  for (const fn of candidates) {
    try {
      const out = fn.call(store, repo, issue, body) as AnyObj | undefined;
      if (out !== null && typeof out === 'object' && typeof out.id === 'string' && out.id !== '') return { id: out.id, body: typeof out.body === 'string' ? out.body : body };
      if (out !== null && typeof out === 'object') return { id: commentGlobalId(readLocalComments(repo, issue).length + 1), body };
    } catch { /* try the next shape */ }
  }
  const repoAny = repo as unknown as Record<string, unknown>;
  const map = repoAny.issueComments;
  if (map instanceof Map) {
    const list = (map.get(issue.number) as Array<AnyObj> | undefined) ?? [];
    let maxId = 0;
    for (const c of list) if (typeof c.id === 'number' && c.id > maxId) maxId = c.id;
    const numericId = maxId + 1;
    list.push({ id: numericId, body, user: { login: 'adaiversen', id: 1000 }, created_at: store.nowIso(), updated_at: store.nowIso() });
    map.set(issue.number, list);
    return { id: commentGlobalId(numericId), body };
  }
  const key = localCommentKey(repo, issue);
  const list = LOCAL_COMMENTS.get(key) ?? [];
  const seq = list.length + 1;
  list.push({ id: commentGlobalId(seq), body, authorLogin: 'adaiversen', createdAt: store.nowIso() });
  LOCAL_COMMENTS.set(key, list);
  return { id: commentGlobalId(seq), body };
}
function listComments(store: StoreLike, repo: RepoLike, issue: IssueLike): Array<{ id: string; body: string; authorLogin: string; createdAt: string }> {
  const repoAny = repo as unknown as Record<string, unknown>;
  const map = repoAny.issueComments;
  if (map instanceof Map) {
    const list = map.get(issue.number) as Array<AnyObj> | undefined;
    if (list !== undefined) return list.map((c, i) => ({ id: typeof c.id === 'number' ? commentGlobalId(c.id) : typeof c.id === 'string' ? c.id : commentGlobalId(i + 1), body: typeof c.body === 'string' ? c.body : '', authorLogin: 'adaiversen', createdAt: typeof c.created_at === 'string' ? c.created_at : issue.created_at }));
  }
  const s = store as unknown as Record<string, unknown>;
  if (typeof s.listComments === 'function') {
    try {
      const out = (s.listComments as (r: unknown, i: unknown) => unknown)(repo, issue) as Array<AnyObj> | undefined;
      if (Array.isArray(out)) return out.map((c, i) => ({ id: typeof c.id === 'number' ? commentGlobalId(c.id) : typeof c.id === 'string' ? c.id : commentGlobalId(i + 1), body: typeof c.body === 'string' ? c.body : '', authorLogin: 'adaiversen', createdAt: typeof c.created_at === 'string' ? c.created_at : issue.created_at }));
    } catch { /* fall through */ }
  }
  return readLocalComments(repo, issue);
}

// ---------------------------------------------------------------------------
// Field resolvers. `parent` is a wrapper ({__type, ...}) or the Query root.
// ---------------------------------------------------------------------------
function strArg(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  return typeof v === 'string' ? v : undefined;
}
function intArg(args: Record<string, unknown>, name: string): number | undefined {
  const v = args[name];
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}
function objArg(args: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const v = args[name];
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function issueState(issue: IssueLike): string { return issue.state === 'closed' ? 'CLOSED' : 'OPEN'; }
function pullState(pr: PullLike): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'closed' ? 'CLOSED' : 'OPEN';
}
function mergeableState(pr: PullLike): string {
  if (pr.mergeable === true) return 'MERGEABLE';
  if (pr.mergeable === false) return 'CONFLICTING';
  return 'UNKNOWN';
}

function resolveField(parent: unknown, parentType: string, field: FieldNode, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const store = ctx.store;
  const p = (parent ?? {}) as AnyObj;
  switch (parentType) {
    case 'Query': {
      if (field.name === 'viewer') return wrap('User', { login: 'adaiversen', id: 1000 });
      if (field.name === 'repository') {
        const owner = strArg(args, 'owner');
        const name = strArg(args, 'name');
        if (owner === undefined || name === undefined) throw new GqlError('repository requires owner and name.');
        const repo = store.getRepo(owner, name) as RepoLike | undefined;
        if (repo === undefined) return null;
        return wrap('Repository', { repo });
      }
      if (field.name === 'node') {
        const id = strArg(args, 'id');
        if (id === undefined) throw new GqlError('node requires id.');
        if (id.startsWith('R_') || /^\d+$/.test(id) || id.includes('/')) {
          const repo = findRepoByGlobalId(store, id);
          if (repo === undefined) return null;
          return wrap('Repository', { repo });
        }
        if (id.startsWith('I_')) {
          const found = findIssueByGlobalId(store, id);
          if (found === undefined) return null;
          return wrap('Issue', { repo: found.repo, issue: found.issue });
        }
        if (id.startsWith('PR_')) {
          const found = findPullByGlobalId(store, id);
          if (found === undefined) return null;
          return wrap('PullRequest', { repo: found.repo, pr: found.pr });
        }
        return null;
      }
      if (field.name === 'search') {
        const type = strArg(args, 'type');
        const query = strArg(args, 'query') ?? '';
        const first = intArg(args, 'first');
        if (type !== undefined && type !== 'ISSUE') return wrap('SearchResultItemConnection', { nodes: [], edges: [], totalCount: 0, pageInfo: pageInfo(false, false, null, null) });
        let repoFilter: RepoLike | undefined;
        const repoMatch = /repo:([^\s]+)/.exec(query);
        if (repoMatch !== null) {
          const full = repoMatch[1] ?? '';
          const slash = full.indexOf('/');
          if (slash > 0) repoFilter = store.getRepo(full.slice(0, slash), full.slice(slash + 1)) as RepoLike | undefined;
        }
        const needle = query.replace(/repo:[^\s]+/g, '').trim().toLowerCase();
        const hits: Array<{ repo: RepoLike; issue: IssueLike }> = [];
        const repos = repoFilter !== undefined ? [repoFilter] : [...store.repos.values()];
        for (const repo of repos) {
          for (const issue of repo.issues) {
            if (needle === '' || issue.title.toLowerCase().includes(needle) || (issue.body ?? '').toLowerCase().includes(needle)) hits.push({ repo, issue });
          }
        }
        hits.sort((a, b) => b.issue.number - a.issue.number);
        const page = first !== undefined ? hits.slice(0, first) : hits;
        const nodes = page.map((h) => wrap('Issue', { repo: h.repo, issue: h.issue }));
        const edges = page.map((h) => edge('SearchResultItemEdge', wrap('Issue', { repo: h.repo, issue: h.issue }), encodeCursor(h.issue.number)));
        return wrap('SearchResultItemConnection', { nodes, edges, totalCount: hits.length, issueCount: hits.length, pageInfo: pageInfo(hits.length > page.length, false, null, null) });
      }
      if (field.name === '__type') {
        const name = strArg(args, 'name');
        if (name === undefined) throw new GqlError('__type requires name.');
        const def = TYPE_DEFS[name];
        if (def === undefined) return null;
        return wrap('__Type', { typeName: name, def });
      }
      if (field.name === '__schema') return wrap('__Schema', {});
      throw new GqlError(`Cannot query field "${field.name}" on type "Query".`);
    }
    case 'Mutation': {
      if (field.name === 'createIssue') return mutateCreateIssue(args, ctx);
      if (field.name === 'closeIssue') return mutateCloseIssue(args, ctx);
      if (field.name === 'createPullRequest') return mutateCreatePullRequest(args, ctx);
      if (field.name === 'mergePullRequest') return mutateMergePullRequest(args, ctx);
      if (field.name === 'addComment') return mutateAddComment(args, ctx);
      throw new GqlError(`Cannot query field "${field.name}" on type "Mutation".`);
    }
    case 'Repository': {
      const repo = p.repo as RepoLike;
      switch (field.name) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.ownerLogin}/${repo.name}`;
        case 'description': return repo.description;
        case 'isPrivate': return repo.private;
        case 'createdAt': return repo.created_at;
        case 'updatedAt': return repo.updated_at;
        case 'url': return `/repos/${repo.ownerLogin}/${repo.name}`;
        case 'owner': return wrap('User', { login: repo.ownerLogin, id: 1000 });
        case 'defaultBranchRef': return wrap('Ref', { name: repo.default_branch, prefix: 'refs/heads/' });
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'issue': {
          const n = intArg(args, 'number');
          if (n === undefined) throw new GqlError('issue requires number.');
          const issue = repo.issueByNumber.get(n);
          return issue === undefined ? null : wrap('Issue', { repo, issue });
        }
        case 'issues': {
          let list = repo.issues.slice();
          const states = args.states;
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((s) => String(s)));
            list = list.filter((i) => wanted.has(issueState(i)));
          }
          const orderBy = objArg(args, 'orderBy');
          if (orderBy !== undefined) {
            const dir = String(orderBy.direction ?? 'DESC');
            list.sort((a, b) => (dir === 'ASC' ? a.number - b.number : b.number - a.number));
          }
          return issueConnection(repo, list, intArg(args, 'first'), args.after);
        }
        case 'pullRequests': return pullConnection(repo, repo.pulls.slice(), intArg(args, 'first'));
        case 'pullRequest': {
          const n = intArg(args, 'number');
          if (n === undefined) throw new GqlError('pullRequest requires number.');
          const pr = repo.pullByNumber.get(n);
          return pr === undefined ? null : wrap('PullRequest', { repo, pr });
        }
        default: throw new GqlError(`Cannot query field "${field.name}" on type "Repository".`);
      }
    }
    case 'Issue': {
      const repo = p.repo as RepoLike;
      const issue = p.issue as IssueLike;
      switch (field.name) {
        case 'id': return issueGlobalId(repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issueState(issue);
        case 'createdAt': return issue.created_at;
        case 'updatedAt': return issue.updated_at;
        case 'closedAt': return issue.closed_at;
        case 'url': return `/repos/${repo.ownerLogin}/${repo.name}/issues/${issue.number}`;
        case 'author': return wrap('User', { login: issue.user.login, id: issue.user.id });
        case 'labels': {
          const nodes = issue.labels.map((name) => wrap('Label', { name, id: `L_${repo.id}_${name}` }));
          const edges = nodes.map((n) => edge('LabelEdge', n, encodeCursor(0)));
          return wrap('LabelConnection', { nodes, edges, totalCount: nodes.length, pageInfo: pageInfo(false, false, null, null) });
        }
        case 'comments': {
          const comments = listComments(ctx.store, repo, issue);
          const nodes = comments.map((c) => wrap('IssueComment', { id: c.id, body: c.body, authorLogin: c.authorLogin, createdAt: c.createdAt }));
          const edges = nodes.map((n) => edge('IssueCommentEdge', n, encodeCursor(0)));
          return wrap('IssueCommentConnection', { nodes, edges, totalCount: nodes.length, pageInfo: pageInfo(false, false, null, null) });
        }
        default: throw new GqlError(`Cannot query field "${field.name}" on type "Issue".`);
      }
    }
    case 'PullRequest': {
      const repo = p.repo as RepoLike;
      const pr = p.pr as PullLike;
      switch (field.name) {
        case 'id': return pullGlobalId(repo, pr);
        case 'number': return pr.number;
        case 'title': return pr.title;
        case 'body': return pr.body;
        case 'state': return pullState(pr);
        case 'merged': return pr.merged;
        case 'mergeable': return mergeableState(pr);
        case 'headRefName': return pr.head.ref;
        case 'baseRefName': return pr.base.ref;
        case 'headRef': return wrap('Ref', { name: pr.head.ref, prefix: 'refs/heads/' });
        case 'baseRef': return wrap('Ref', { name: pr.base.ref, prefix: 'refs/heads/' });
        case 'createdAt': return pr.created_at;
        case 'updatedAt': return pr.updated_at;
        case 'mergedAt': return pr.merged_at;
        case 'url': return `/repos/${repo.ownerLogin}/${repo.name}/pull/${pr.number}`;
        case 'author': return wrap('User', { login: pr.user.login, id: pr.user.id });
        case 'additions': case 'deletions': case 'changedFiles': {
          const paths = prChangedPaths(ctx.store, repo, pr);
          if (field.name === 'changedFiles') return paths.length;
          return 0;
        }
        case 'files': {
          const paths = prChangedPaths(ctx.store, repo, pr);
          const first = intArg(args, 'first');
          const page = first !== undefined ? paths.slice(0, first) : paths;
          const nodes = page.map((path) => wrap('PullRequestChangedFile', { path, additions: 0, deletions: 0, changeType: 'ADDED' }));
          const edges = page.map((n) => edge('PullRequestChangedFileEdge', n, encodeCursor(0)));
          return wrap('PullRequestChangedFileConnection', { nodes, edges, totalCount: paths.length, pageInfo: pageInfo(paths.length > page.length, false, null, null) });
        }
        default: throw new GqlError(`Cannot query field "${field.name}" on type "PullRequest".`);
      }
    }
    case 'User': {
      const login = p.login as string;
      switch (field.name) {
        case 'login': return login;
        case 'id': return typeof p.id === 'number' ? p.id : 1000;
        case 'name': return login;
        case 'email': return null;
        case 'url': return `/${login}`;
        default: throw new GqlError(`Cannot query field "${field.name}" on type "User".`);
      }
    }
    case 'Ref': {
      if (field.name === 'name') return p.name as string;
      if (field.name === 'prefix') return (p.prefix as string) ?? 'refs/heads/';
      throw new GqlError(`Cannot query field "${field.name}" on type "Ref".`);
    }
    case 'IssueConnection': case 'PullRequestConnection': case 'PullRequestChangedFileConnection':
    case 'SearchResultItemConnection': case 'LabelConnection': case 'IssueCommentConnection': {
      switch (field.name) {
        case 'nodes': return (p.nodes as unknown[]) ?? [];
        case 'edges': return (p.edges as unknown[]) ?? [];
        case 'totalCount': return (p.totalCount as number) ?? ((p.nodes as unknown[] | undefined)?.length ?? 0);
        case 'issueCount': return (p.issueCount as number) ?? (p.totalCount as number) ?? 0;
        case 'pageInfo': return p.pageInfo as unknown;
        default: throw new GqlError(`Cannot query field "${field.name}" on type "${parentType}".`);
      }
    }
    case 'IssueEdge': case 'PullRequestEdge': case 'PullRequestChangedFileEdge':
    case 'SearchResultItemEdge': case 'LabelEdge': case 'IssueCommentEdge': {
      if (field.name === 'node') return p.node as unknown;
      if (field.name === 'cursor') return p.cursor as string;
      throw new GqlError(`Cannot query field "${field.name}" on type "${parentType}".`);
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return p.path as string;
      if (field.name === 'additions') return 0;
      if (field.name === 'deletions') return 0;
      if (field.name === 'changeType') return 'ADDED';
      throw new GqlError(`Cannot query field "${field.name}" on type "PullRequestChangedFile".`);
    }
    case 'Label': {
      if (field.name === 'name') return p.name as string;
      if (field.name === 'id') return (p.id as string) ?? '';
      if (field.name === 'description') return null;
      if (field.name === 'color') return null;
      throw new GqlError(`Cannot query field "${field.name}" on type "Label".`);
    }
    case 'IssueComment': {
      if (field.name === 'id') return p.id as string;
      if (field.name === 'body') return p.body as string;
      if (field.name === 'author') return wrap('User', { login: (p.authorLogin as string) ?? 'adaiversen', id: 1000 });
      if (field.name === 'createdAt') return (p.createdAt as string) ?? null;
      throw new GqlError(`Cannot query field "${field.name}" on type "IssueComment".`);
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return p.hasNextPage as boolean;
      if (field.name === 'hasPreviousPage') return p.hasPreviousPage as boolean;
      if (field.name === 'startCursor') return (p.startCursor as string | null) ?? null;
      if (field.name === 'endCursor') return (p.endCursor as string | null) ?? null;
      throw new GqlError(`Cannot query field "${field.name}" on type "PageInfo".`);
    }
    case '__Type': {
      const def = p.def as TypeDef;
      const typeName = p.typeName as string;
      switch (field.name) {
        case 'name': return typeName;
        case 'kind': return def.kind;
        case 'description': return null;
        case 'fields': return def.fields.map((f) => wrap('__Field', { fieldName: f.name, fieldType: f.type }));
        case 'enumValues': return def.enumValues.map((name) => wrap('__EnumValue', { enumName: name }));
        case 'inputFields': return [];
        case 'interfaces': return [];
        case 'possibleTypes': return [];
        case 'ofType': {
          const ot = p.ofType as TypeRef | null | undefined;
          return ot !== null && ot !== undefined ? typeRefValue(ot) : null;
        }
        default: throw new GqlError(`Cannot query field "${field.name}" on type "__Type".`);
      }
    }
    case '__Field': {
      switch (field.name) {
        case 'name': return p.fieldName as string;
        case 'description': return null;
        case 'args': return [];
        case 'type': return typeRefValue(p.fieldType as TypeRef);
        case 'isDeprecated': return false;
        case 'deprecationReason': return null;
        default: throw new GqlError(`Cannot query field "${field.name}" on type "__Field".`);
      }
    }
    case '__EnumValue': {
      switch (field.name) {
        case 'name': return p.enumName as string;
        case 'description': return null;
        case 'isDeprecated': return false;
        case 'deprecationReason': return null;
        default: throw new GqlError(`Cannot query field "${field.name}" on type "__EnumValue".`);
      }
    }
    case '__InputValue': {
      switch (field.name) {
        case 'name': return p.name as string;
        case 'description': return null;
        case 'type': return typeRefValue((p.inputType as TypeRef) ?? STR);
        case 'defaultValue': return null;
        default: throw new GqlError(`Cannot query field "${field.name}" on type "__InputValue".`);
      }
    }
    case '__Schema': {
      switch (field.name) {
        case 'queryType': return wrap('__Type', { typeName: 'Query', def: TYPE_DEFS.Query });
        case 'mutationType': return wrap('__Type', { typeName: 'Mutation', def: TYPE_DEFS.Mutation });
        case 'subscriptionType': return null;
        case 'types': return Object.entries(TYPE_DEFS).map(([name, def]) => wrap('__Type', { typeName: name, def }));
        case 'directives': return [];
        default: throw new GqlError(`Cannot query field "${field.name}" on type "__Schema".`);
      }
    }
    case '__Directive': {
      if (field.name === 'name') return p.name as string;
      if (field.name === 'description') return null;
      if (field.name === 'locations') return [];
      if (field.name === 'args') return [];
      throw new GqlError(`Cannot query field "${field.name}" on type "__Directive".`);
    }
    case 'Payload': {
      const v = (p.fields as Record<string, unknown>)[field.name];
      if (v === undefined) {
        if (field.name === 'clientMutationId') return (p.fields as Record<string, unknown>).clientMutationId ?? null;
        throw new GqlError(`Cannot query field "${field.name}" on payload.`);
      }
      return v;
    }
    default:
      throw new GqlError(`Cannot query field "${field.name}" on type "${parentType}".`);
  }
}
function typeRefValue(t: TypeRef): AnyObj {
  return wrap('__Type', { typeName: t.name, def: { kind: t.kind, fields: [], enumValues: [] } as TypeDef, ofType: t.ofType });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------
function clientMutationIdOf(input: Record<string, unknown>): string | null {
  return typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
}
function mutateCreateIssue(args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const input = objArg(args, 'input') ?? {};
  const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(ctx.store, input.repositoryId) : undefined;
  if (repo === undefined) throw new GqlError('createIssue: repository not found for the given repositoryId.');
  const title = input.title;
  if (typeof title !== 'string' || title === '') throw new GqlError('createIssue: input.title is required.');
  const body = typeof input.body === 'string' ? input.body : null;
  const labels = Array.isArray(input.labels) ? input.labels.filter((l): l is string => typeof l === 'string') : [];
  const issue = (ctx.store as StoreLike).createIssue(repo, title, body, labels) as IssueLike;
  return wrap('Payload', { fields: { issue: wrap('Issue', { repo, issue }), clientMutationId: clientMutationIdOf(input) } });
}
function mutateCloseIssue(args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const input = objArg(args, 'input') ?? {};
  const found = typeof input.issueId === 'string' ? findIssueByGlobalId(ctx.store, input.issueId) : undefined;
  if (found === undefined) throw new GqlError('closeIssue: issue not found for the given issueId.');
  found.issue.state = 'closed';
  found.issue.closed_at = ctx.store.nowIso();
  found.issue.updated_at = ctx.store.nowIso();
  (found.repo as unknown as { issueBodyCache?: Map<number, string> }).issueBodyCache?.delete(found.issue.number);
  return wrap('Payload', { fields: { issue: wrap('Issue', { repo: found.repo, issue: found.issue }), clientMutationId: clientMutationIdOf(input) } });
}
function mutateCreatePullRequest(args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const input = objArg(args, 'input') ?? {};
  const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(ctx.store, input.repositoryId) : undefined;
  if (repo === undefined) throw new GqlError('createPullRequest: repository not found for the given repositoryId.');
  const head = input.headRefName;
  const base = input.baseRefName;
  const title = input.title;
  if (typeof head !== 'string' || head === '') throw new GqlError('createPullRequest: input.headRefName is required.');
  if (typeof base !== 'string' || base === '') throw new GqlError('createPullRequest: input.baseRefName is required.');
  if (typeof title !== 'string' || title === '') throw new GqlError('createPullRequest: input.title is required.');
  if (!repo.refs.has(`refs/heads/${head}`)) throw new GqlError(`createPullRequest: head branch "${head}" does not exist.`);
  if (!repo.refs.has(`refs/heads/${base}`)) throw new GqlError(`createPullRequest: base branch "${base}" does not exist.`);
  const body = typeof input.body === 'string' ? input.body : null;
  const pr = (ctx.store as StoreLike).createPull(repo, title, body, head, base) as PullLike;
  return wrap('Payload', { fields: { pullRequest: wrap('PullRequest', { repo, pr }), clientMutationId: clientMutationIdOf(input) } });
}
function mutateMergePullRequest(args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const input = objArg(args, 'input') ?? {};
  const found = typeof input.pullRequestId === 'string' ? findPullByGlobalId(ctx.store, input.pullRequestId) : undefined;
  if (found === undefined) throw new GqlError('mergePullRequest: pull request not found for the given pullRequestId.');
  const merged = (ctx.store as StoreLike).mergePull(found.repo, found.pr) as { sha: string; message: string } | null;
  if (merged === null) throw new GqlError('mergePullRequest: the pull request could not be merged (already merged or closed).');
  return wrap('Payload', { fields: { pullRequest: wrap('PullRequest', { repo: found.repo, pr: found.pr }), clientMutationId: clientMutationIdOf(input) } });
}
function mutateAddComment(args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const input = objArg(args, 'input') ?? {};
  const found = typeof input.subjectId === 'string' ? findIssueByGlobalId(ctx.store, input.subjectId) : undefined;
  if (found === undefined) throw new GqlError('addComment: subject not found for the given subjectId.');
  const body = input.body;
  if (typeof body !== 'string' || body === '') throw new GqlError('addComment: input.body is required.');
  const comment = addCommentToStore(ctx.store, found.repo, found.issue, body);
  found.issue.comments += 1;
  (found.repo as unknown as { issueBodyCache?: Map<number, string> }).issueBodyCache?.delete(found.issue.number);
  const node = wrap('IssueComment', { id: comment.id, body: comment.body, authorLogin: 'adaiversen', createdAt: ctx.store.nowIso() });
  return wrap('Payload', { fields: { commentEdge: wrap('IssueCommentEdge', { node, cursor: encodeCursor(0) }), clientMutationId: clientMutationIdOf(input) } });
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
function sendJson(res: ServerResponse, status: number, requestId: string, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId });
  res.end(text);
}
function authorized(req: IncomingMessage, store: StoreLike): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  return header === `Bearer ${store.token}`;
}

function envelope(result: { data: unknown; errors: Array<{ message: string; path?: Array<string | number> }> }): unknown {
  return result.errors.length > 0 ? result : { data: result.data };
}

async function handleGraphqlInner(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let path = '/';
  try { path = new URL(req.url ?? '/', 'http://entry').pathname; } catch { path = '/'; }
  if (req.method !== 'POST' || path !== '/api/graphql') return false;
  const s = store as unknown as StoreLike;
  const requestId = s.nextRequestId();
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, requestId, { message: 'Bad Request' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    sendJson(res, 400, requestId, { message: 'Request body is not valid JSON' });
    return true;
  }
  if (!authorized(req, s)) {
    sendJson(res, 401, requestId, { message: 'Requires authentication' });
    return true;
  }
  if (Array.isArray(parsed)) {
    // GitHub operation batching: one JSON array, one response per operation, in order.
    const out: unknown[] = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || typeof (entry as Record<string, unknown>).query !== 'string') {
        out.push({ data: null, errors: [{ message: 'Each batched operation needs a query string.' }] });
        continue;
      }
      const rec = entry as Record<string, unknown>;
      const vars = rec.variables !== null && typeof rec.variables === 'object' && !Array.isArray(rec.variables) ? (rec.variables as Record<string, unknown>) : {};
      const opName = typeof rec.operationName === 'string' ? rec.operationName : undefined;
      out.push(envelope(runDocument(rec.query as string, vars, opName, s)));
    }
    sendJson(res, 200, requestId, out);
    return true;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).query !== 'string') {
    sendJson(res, 400, requestId, { message: 'Request body must be a JSON object with a query string' });
    return true;
  }
  const rec = parsed as Record<string, unknown>;
  const vars = rec.variables !== null && typeof rec.variables === 'object' && !Array.isArray(rec.variables) ? (rec.variables as Record<string, unknown>) : {};
  const opName = typeof rec.operationName === 'string' ? rec.operationName : undefined;
  const result = runDocument(rec.query as string, vars, opName, s);
  sendJson(res, 200, requestId, envelope(result));
  return true;
}
