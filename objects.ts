// Git 对象层（REST+Store 组为联调先行实现；Git 组复核后可替换同接口实现）。
// 纯 Node 标准库：对象格式为 "<type> <len>\0<data>" 的 SHA-1，与 git 兼容。
import { createHash } from 'node:crypto';
import type { GitObject } from './store.ts';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function getObject(objects: Map<string, GitObject>, sha: string): GitObject | undefined {
  return objects.get(sha);
}

export function storeObject(objects: Map<string, GitObject>, type: GitObject['type'], data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  const sha = createHash('sha1').update(header).update(data).digest('hex');
  objects.set(sha, { type, data });
  return sha;
}

export function formatCommit(tree: string, parents: string[], authorLine: string, committerLine: string, message: string): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${authorLine}`, `committer ${committerLine}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

/** git 树排序：目录按 name+'/' 参与比较。 */
function compareTreeNames(a: { mode: string; name: string }, b: { mode: string; name: string }): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export function formatTree(entries: { mode: string; name: string; sha: string }[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Buffer): { tree: string; parents: string[]; author: string; committer: string; message: string } {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function parseTree(data: Buffer): { mode: string; name: string; sha: string }[] {
  const out: { mode: string; name: string; sha: string }[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const nul = data.indexOf(0x00, sp);
    if (nul < 0 || nul + 21 > data.length) break;
    out.push({ mode: data.subarray(i, sp).toString('utf8'), name: data.subarray(sp + 1, nul).toString('utf8'), sha: data.subarray(nul + 1, nul + 21).toString('hex') });
    i = nul + 21;
  }
  return out;
}

export function isAncestor(objects: Map<string, GitObject>, ancestorSha: string, sha: string): boolean {
  if (ancestorSha === sha) return true;
  const seen = new Set<string>();
  const stack: string[] = [sha];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === ancestorSha) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = objects.get(cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

/** tag 对象一路剥到它最终指向的对象（防环）。 */
function peelTag(objects: Map<string, GitObject>, sha: string): string {
  let current = sha;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const object = objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    let target = '';
    const blank = object.data.indexOf('\n\n');
    const head = object.data.subarray(0, blank < 0 ? object.data.length : blank).toString('utf8');
    for (const line of head.split('\n')) {
      if (line.startsWith('object ')) {
        target = line.slice(7).trim();
        break;
      }
    }
    if (target === '') return current;
    current = target;
  }
}

/**
 * 从若干 commit 出发可达的全部对象 sha（含 commit/tree/blob/tag）。
 * 缺失对象时抛错，不静默报不完整——调用方据此判定 unpack/fetch 失败。
 */
export function collectReachable(objects: Map<string, GitObject>, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const tip of tips) {
    if (/^[0-9a-f]{40}$/.test(tip)) queue.push(tip);
  }
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) throw new Error(`object ${oid} is missing from the store`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(peelTag(objects, oid));
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue; // gitlink：本库不持有的 commit
        queue.push(entry.sha);
      }
    }
  }
  return seen;
}

export function commitTreeSha(objects: Map<string, GitObject>, commitSha: string): string | undefined {
  const object = objects.get(commitSha);
  if (object === undefined || object.type !== 'commit') return undefined;
  const tree = parseCommit(object.data).tree;
  return tree === '' ? undefined : tree;
}

/**
 * 以固定 epoch 建 commit 并落库（author/committer 同一身份，绝不用 Date.now()）。
 * author/committer 行格式：`Name <email> <epoch> +0000`。
 */
export function createCommit(
  objects: Map<string, GitObject>,
  treeSha: string,
  parents: string[],
  message: string,
  authorName: string,
  authorEmail: string,
  epochSec: number,
): string {
  const line = `${authorName} <${authorEmail}> ${epochSec} +0000`;
  return storeObject(objects, 'commit', formatCommit(treeSha, parents, line, line, message));
}
