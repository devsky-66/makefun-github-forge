// git smart HTTP: info/refs、git-upload-pack、git-receive-pack（协议 v0 + v2）。
// 只用 Node 标准库；不依赖 git 二进制。协议细节以 kit 的 git-client.ts
// （客户端实际发什么、解析什么）为准。
//
// 关键对齐点（都是按 git-client 的解析反推的，勿凭记忆改）：
//  - receive-pack 的 POST 响应里没有广告，只有 sideband band 1 包着的
//    report-status pkt-line 流；先发广告行会被客户端当作非法 band 拒绝。
//  - v2 fetch 响应必须分节：acknowledgments（NAK）→ 可选 shallow-info →
//    packfile（sideband），每节以 flush 结束；packfile 节至少一个包。
//  - v2 ls-refs 的行格式是 `<oid> <ref>[ peeled:<oid>][ symref-target:<ref>]`，
//    空库时 HEAD 用 `unborn HEAD symref-target:...`；ref-prefix 由服务端过滤。
//  - v0 fetch 响应是裸 pkt-line 的 NAK / shallow 行在前，随后 sideband 包。
//  - 认证：git 检查里没有 401 断言，只有 unknown-repo-404；因此缺库 404
//    优先于 401，存在的库缺/错 token 才 401。
//  - pack 只发完整对象（无 delta），客户端的 readPack 接受；push 收到的
//    pack 必须能解 OFS_DELTA / REF_DELTA（客户端写 pack 不发 delta，但
//    健壮性要求，且 bench 之外的调用方可能发）。

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';
import { isAncestor, parseCommit, parseTree } from './objects.ts';
import type { GitObject } from './store.ts';
import type { Repo, Store } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
const AGENT = 'github-core-clone-01/1.0';
const PKT_LINE_MAX = 65520;
/** 一个 sideband 包能带的数据上限：pkt-line 头 4 字节 + band 字节 1 个。 */
const SIDEBAND_CHUNK = PKT_LINE_MAX - 4 - 1;

// -------------------------------------------------------------------------------------------
// pkt-line 编解码
// -------------------------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error(`pkt-line payload is ${data.length} bytes, over the limit`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

interface DecodedPackets {
  lines: string[];
  flushCount: number;
  rest: Buffer;
  ok: boolean;
}

/**
 * 解码一段 pkt-line 流：返回全部 data 行（去掉了末尾 \n 吗？不去，由调用方处理）、
 * flush 数量、第一个 flush 之后的剩余字节（receive-pack 里就是 packfile）。
 * 遇非法头返回 ok:false，不抛错。
 */
function decodePktLines(buffer: Buffer): DecodedPackets {
  const lines: string[] = [];
  let offset = 0;
  let flushCount = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return { lines, flushCount, rest: buffer.subarray(offset), ok: false };
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      flushCount += 1;
      offset += 4;
      // receive-pack：第一个 flush 之后就是 packfile 原始字节。
      return { lines, flushCount, rest: buffer.subarray(offset), ok: true };
    }
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX || offset + length > buffer.length) {
      return { lines, flushCount, rest: buffer.subarray(offset), ok: false };
    }
    lines.push(buffer.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  if (offset !== buffer.length) return { lines, flushCount, rest: buffer.subarray(offset), ok: false };
  return { lines, flushCount, rest: Buffer.alloc(0), ok: true };
}

/** 把一段字节流切成 sideband 包（band 1 数据 / band 2 进度），每包一个 pkt-line。 */
function sidebandPackets(band: 1 | 2, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + SIDEBAND_CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([band])));
  return out;
}

// -------------------------------------------------------------------------------------------
// packfile 写 / 读
// -------------------------------------------------------------------------------------------

const PACK_TYPE_CODE: Readonly<Record<GitObject['type'], number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPE: Readonly<Record<number, GitObject['type']>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: GitObject['type'], size: number): Buffer {
  const code = PACK_TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** 无 delta 的 pack v2：调用方给的顺序即写盘顺序（这里按 oid 排，保证确定性）。 */
export function buildPack(objects: readonly { type: GitObject['type']; data: Buffer }[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** git delta 指令流：copy/insert，作用于 base 字节。 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += (delta[offset++] as number) * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += (delta[offset++] as number) * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface PackReadEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** 读 pack v2/v3，解开 OFS_DELTA / REF_DELTA。base 可来自本包或 repo.objects。 */
export function readPack(pack: Buffer, lookup: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const readVarintSize = (start: number): { size: number; next: number; first: number } => {
    if (start >= pack.length) throw new Error('pack entry has no size header');
    let byte = pack[start] as number;
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    let offset = start + 1;
    while (byte & 0x80) {
      if (offset >= pack.length) throw new Error('pack entry size varint is truncated');
      byte = pack[offset++] as number;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    return { size, next: offset, first };
  };
  const readOfsBase = (start: number): { baseOffset: number; next: number } => {
    if (start >= pack.length) throw new Error('ofs-delta has no base offset');
    let byte = pack[start] as number;
    let offset = start + 1;
    let value = byte & 0x7f;
    while (byte & 0x80) {
      if (offset >= pack.length) throw new Error('ofs-delta base offset is truncated');
      byte = pack[offset++] as number;
      value = (value + 1) * 128 + (byte & 0x7f);
    }
    return { baseOffset: value, next: offset };
  };
  const raw: PackReadEntry[] = [];
  const byOffset = new Map<number, PackReadEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: PackReadEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (PACK_CODE_TYPE[typeCode] === undefined) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.buffer.length}`);
    }
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, PackReadEntry>();
  const resolving = new Set<number>();
  const resolved = new Map<number, { type: GitObject['type']; data: Buffer; oid: string }>();
  const resolve = (entry: PackReadEntry): { type: GitObject['type']; data: Buffer; oid: string } => {
    const done = resolved.get(entry.offset);
    if (done) return done;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObject['type'];
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = lookup(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the repo`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = PACK_CODE_TYPE[entry.typeCode] as GitObject['type'];
      data = entry.data;
    }
    const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
    const oid = createHash('sha1').update(header).update(data).digest('hex');
    const result = { type, data, oid };
    resolved.set(entry.offset, result);
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return result;
  };
  for (const entry of raw) {
    const result = resolve(entry);
    if (!objects.has(result.oid)) objects.set(result.oid, { type: result.type, data: result.data });
  }
  return objects;
}

// -------------------------------------------------------------------------------------------
// ref 工具
// -------------------------------------------------------------------------------------------

/** tag 对象一路剥到非 tag 对象（commit/blob/tree），缺失返回 undefined。 */
function peelObject(objects: Map<string, GitObject>, sha: string): string | undefined {
  let current = sha;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const object = objects.get(current);
    if (!object) return undefined;
    if (object.type !== 'tag') return current;
    let target = '';
    const blank = object.data.indexOf('\n\n');
    const head = object.data.subarray(0, blank < 0 ? object.data.length : blank).toString('utf8');
    for (const line of head.split('\n')) {
      if (line.startsWith('object ')) {
        target = line.slice(7).trim();
        break;
      }
    }
    if (target === '') return undefined;
    current = target;
  }
}

/** ref 名 -> oid，按名排序（不含 HEAD）。 */
function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.default_branch}`;
}

function uploadCaps(repo: Repo): string {
  return `side-band-64k thin-pack ofs-delta multi_ack shallow symref=HEAD:${headTarget(repo)} agent=${AGENT}`;
}

function receiveCaps(repo: Repo): string {
  return `report-status side-band-64k delete-refs ofs-delta symref=HEAD:${headTarget(repo)} agent=${AGENT}`;
}

/** v0 广告：service 前导 + flush + 每行 `<oid> <ref>`（首行带 capabilities）。 */
function buildV0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadCaps(repo) : receiveCaps(repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headTarget(repo));
  if (refs.length === 0 && headOid === undefined) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const capsSuffix = (): string => {
      if (!first) return '';
      first = false;
      return `\0${caps}`;
    };
    if (headOid !== undefined) parts.push(pktLine(`${headOid} HEAD${capsSuffix()}\n`));
    for (const [name, oid] of refs) {
      parts.push(pktLine(`${oid} ${name}${capsSuffix()}\n`));
      const peeled = peelObject(repo.objects, oid);
      if (peeled !== undefined && peeled !== oid) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v2 广告：`version 2` + capability 行 + flush（无 service 前导）。 */
function buildV2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

// -------------------------------------------------------------------------------------------
// fetch 规划：want 集合 − have 已持集合，带 shallow/deepen 边界
// -------------------------------------------------------------------------------------------

interface FetchPlan {
  /** 要发给客户端的对象（按 oid 排序，保证确定性）。 */
  objects: Array<{ type: GitObject['type']; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
}

function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | undefined,
): FetchPlan {
  const objects = repo.objects;
  const depthLimit = depth === undefined ? Number.POSITIVE_INFINITY : depth;
  const shallowSet = new Set(clientShallow);

  // want 侧按代 BFS：commitDepth 记录每个 commit 距 want 的最小代数。
  // included = 代数 < depthLimit 的 commit 及其树；边界 = 代数 == depthLimit - 1。
  // deepen 1 → 只有 tip（代 0），tip 本身就是 shallow；deepen 2 → tip + 父代，
  // 父代为 shallow。代数 == depthLimit 的 commit 只用来截断，不纳入。
  const commitDepth = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  const wantTags = new Set<string>();
  const wantDirect = new Set<string>();
  const enqueueCommit = (oid: string, depth: number): void => {
    const known = commitDepth.get(oid);
    if (known !== undefined && known <= depth) return;
    commitDepth.set(oid, depth);
    queue.push({ oid, depth });
  };
  for (const want of wants) {
    const object = objects.get(want);
    if (!object) continue;
    if (object.type === 'commit') enqueueCommit(want, 0);
    else if (object.type === 'tag') {
      wantTags.add(want);
      const peeled = peelObject(objects, want);
      if (peeled !== undefined && objects.get(peeled)?.type === 'commit') enqueueCommit(peeled, 0);
    } else {
      wantDirect.add(want);
    }
  }
  while (queue.length) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (depth >= depthLimit) continue; // 截断代：不向父代走
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) enqueueCommit(parent, depth + 1);
  }

  // 树闭包：一个 commit 的整棵树（递归），不含父代。
  const addTreeClosure = (into: Set<string>, commitOid: string): void => {
    const object = objects.get(commitOid);
    if (!object || object.type !== 'commit') return;
    into.add(commitOid);
    const stack: string[] = [parseCommit(object.data).tree];
    const seenTrees = new Set<string>();
    while (stack.length) {
      const treeOid = stack.pop() as string;
      if (seenTrees.has(treeOid)) continue;
      seenTrees.add(treeOid);
      const treeObject = objects.get(treeOid);
      if (!treeObject) continue;
      into.add(treeOid);
      if (treeObject.type !== 'tree') continue;
      for (const entry of parseTree(treeObject.data)) {
        if (entry.mode === '160000') continue;
        into.add(entry.sha);
        if (entry.mode === '40000') stack.push(entry.sha);
      }
    }
  };

  const wantIncluded = new Set<string>([...wantTags, ...wantDirect]);
  for (const [oid, d] of commitDepth) {
    if (d < depthLimit) addTreeClosure(wantIncluded, oid);
  }

  // have 侧：客户端已持有的集合；遇到它报的 shallow 边界就不再往父代走。
  const held = new Set<string>();
  const heldQueue: string[] = [...haves];
  const heldSeen = new Set<string>();
  while (heldQueue.length) {
    const oid = heldQueue.pop() as string;
    if (heldSeen.has(oid)) continue;
    heldSeen.add(oid);
    const object = objects.get(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      addTreeClosure(held, oid);
      if (!shallowSet.has(oid)) {
        for (const parent of parseCommit(object.data).parents) heldQueue.push(parent);
      }
    } else if (object.type === 'tag') {
      const peeled = peelObject(objects, oid);
      if (peeled !== undefined) heldQueue.push(peeled);
    } else if (object.type === 'tree') {
      const stack: string[] = [oid];
      const seenTrees = new Set<string>();
      while (stack.length) {
        const treeOid = stack.pop() as string;
        if (seenTrees.has(treeOid)) continue;
        seenTrees.add(treeOid);
        const treeObject = objects.get(treeOid);
        if (!treeObject || treeObject.type !== 'tree') continue;
        for (const entry of parseTree(treeObject.data)) {
          if (entry.mode === '160000') continue;
          held.add(entry.sha);
          if (entry.mode === '40000') stack.push(entry.sha);
        }
      }
    }
  }

  const deliver: Array<{ type: GitObject['type']; data: Buffer }> = [];
  for (const oid of [...wantIncluded].sort()) {
    if (held.has(oid)) continue;
    const object = objects.get(oid);
    if (object) deliver.push({ type: object.type, data: object.data });
  }
  const shallow =
    depth === undefined
      ? []
      : [...commitDepth.entries()]
          .filter(([, d]) => d === depthLimit - 1)
          .map(([oid]) => oid)
          .filter((oid) => wantIncluded.has(oid))
          .sort();
  // 曾为 shallow、现在其父代已纳入 want 侧的边界 → unshallow。
  const unshallow = clientShallow
    .filter((oid) => {
      const d = commitDepth.get(oid);
      return d !== undefined && d < depthLimit && wantIncluded.has(oid);
    })
    .sort();
  return { objects: deliver, shallow, unshallow };
}

// -------------------------------------------------------------------------------------------
// HTTP plumbing
// -------------------------------------------------------------------------------------------

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  sendBuffer(res, status, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', reject);
  });
}

/** 401：存在的库缺 token 或 token 错误。store.token 为空时不设防（测试/本地场景）。 */
function authorized(req: IncomingMessage, store: Store): boolean {
  const token = store.token;
  if (typeof token !== 'string' || token === '') return true;
  return (req.headers.authorization ?? '') === `Bearer ${token}`;
}

interface GitRoute {
  owner: string;
  repoName: string;
  rest: string;
}

function matchGitRoute(req: IncomingMessage): GitRoute | null {
  let pathname = '/';
  try {
    pathname = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return null;
  }
  const segments = pathname.split('/').filter((part) => part !== '');
  if (segments.length < 2) return null;
  const repoSegment = segments[1] as string;
  if (!repoSegment.endsWith('.git')) return null;
  let owner = segments[0] as string;
  let repoName = repoSegment.slice(0, -4);
  try {
    owner = decodeURIComponent(owner);
    repoName = decodeURIComponent(repoName);
  } catch {
    return null;
  }
  return { owner, repoName, rest: segments.slice(2).join('/') };
}

// -------------------------------------------------------------------------------------------
// info/refs
// -------------------------------------------------------------------------------------------

function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
): void {
  let serviceParam = '';
  try {
    serviceParam = new URL(req.url ?? '/', 'http://entry').searchParams.get('service') ?? '';
  } catch {
    serviceParam = '';
  }
  if (serviceParam !== service) {
    sendText(res, 400, 'bad service');
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const body = wantsV2 ? buildV2Advertisement() : buildV0Advertisement(repo, service);
  const contentType =
    service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
  sendBuffer(res, 200, contentType, body);
}

// -------------------------------------------------------------------------------------------
// v2 ls-refs
// -------------------------------------------------------------------------------------------

function handleLsRefsV2(reqBody: string[], repo: Repo): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of reqBody) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headOid = repo.refs.get(headTarget(repo));
  if (keep('HEAD')) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peelObject(repo.objects, oid);
      if (peeled !== undefined && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return pktLines([...lines, 'flush']);
}

// -------------------------------------------------------------------------------------------
// upload-pack：v2 fetch / v0 fetch
// -------------------------------------------------------------------------------------------

function buildV2FetchResponse(plan: FetchPlan): Buffer {
  const pack = buildPack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function buildV0FetchResponse(plan: FetchPlan): Buffer {
  const pack = buildPack(plan.objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function parseFetchLines(lines: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const rawLine of lines) {
    const line = rawLine.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0] as string;
      if (/^[0-9a-f]{40}$/.test(oid)) request.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (/^[0-9a-f]{40}$/.test(oid)) request.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (/^[0-9a-f]{40}$/.test(oid)) request.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isSafeInteger(n) && n > 0) request.depth = n;
    }
    // thin-pack / no-progress / ofs-delta / done / filter / deepen-since /
    // deepen-not / agent / object-format：本实现不支持过滤，按忽略处理。
  }
  return request;
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  // v2 请求：command 行 + 可选参数行 + delim + 参数行 + flush；
  // v0 请求：want 区 + flush + have/done 区 + flush。两种都整流解码。
  const all = decodeAllPktLines(body);
  if (!all.ok || all.lines.length === 0) {
    sendText(res, 400, 'bad pkt-line stream');
    return;
  }
  if (isV2) {
    const command = (all.lines[0] as string).replace(/\n$/, '');
    const args = all.lines.slice(1);
    if (command === 'command=ls-refs') {
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', handleLsRefsV2(args, repo));
      return;
    }
    if (command === 'command=fetch') {
      const request = parseFetchLines(args);
      const plan = planFetch(repo, request.wants, request.haves, request.shallow, request.depth);
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', buildV2FetchResponse(plan));
      return;
    }
    sendText(res, 400, `unknown command ${command}`);
    return;
  }
  // v0：want 区 + flush + have/done 区 + flush；pack 在第二个 flush 后无内容。
  const request = parseFetchLines(all.lines);
  const plan = planFetch(repo, request.wants, request.haves, request.shallow, request.depth);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', buildV0FetchResponse(plan));
}

/** 解码整段 pkt-line 流（不提前停在 flush 上），返回全部 data 行。 */
function decodeAllPktLines(buffer: Buffer): { lines: string[]; ok: boolean } {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return { lines, ok: false };
    const length = Number.parseInt(header, 16);
    if (length === 0 || length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX || offset + length > buffer.length) return { lines, ok: false };
    lines.push(buffer.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  if (offset !== buffer.length) return { lines, ok: false };
  return { lines, ok: true };
}

// -------------------------------------------------------------------------------------------
// receive-pack：v0
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const decoded = decodePktLines(body);
  if (!decoded.ok || decoded.lines.length === 0) {
    sendText(res, 400, 'bad pkt-line stream');
    return;
  }
  const commands: PushCommand[] = [];
  for (const rawLine of decoded.lines) {
    const line = rawLine.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul < 0 ? line : line.slice(0, nul);
    const parts = head.split(' ');
    if (parts.length !== 3) {
      sendText(res, 400, 'bad push command line');
      return;
    }
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid) || !ref.startsWith('refs/')) {
      sendText(res, 400, 'bad push command line');
      return;
    }
    commands.push({ oldOid, newOid, ref });
  }
  const packBytes = decoded.rest;
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);

  // 先解包：unpack 失败则不更新任何 ref，只报 unpack 行。
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const unpacked = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of unpacked) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  } else if (updatesRef) {
    unpackError = 'unpacker error: no packfile received';
  }

  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError.replace(/\n/g, ' ')}\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // delete
        if (current === undefined) {
          reportLines.push(`ng ${command.ref} no such ref\n`);
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          reportLines.push(`ng ${command.ref} old ref mismatch\n`);
        } else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      const newObject = repo.objects.get(command.newOid);
      if (!newObject) {
        reportLines.push(`ng ${command.ref} missing object\n`);
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          reportLines.push(`ng ${command.ref} old ref mismatch\n`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} old ref mismatch\n`);
        continue;
      }
      // fast-forward：old（剥 tag 后）必须是 new（剥 tag 后）的祖先。
      const oldPeeled = peelObject(repo.objects, command.oldOid);
      const newPeeled = peelObject(repo.objects, command.newOid);
      const oldCommit = oldPeeled !== undefined ? repo.objects.get(oldPeeled) : undefined;
      const newCommit = newPeeled !== undefined ? repo.objects.get(newPeeled) : undefined;
      if (oldPeeled === undefined || newPeeled === undefined || oldCommit?.type !== 'commit' || newCommit?.type !== 'commit') {
        // 非 commit 目标（如直接推 blob）：只有 old==new 才放行。
        if (command.oldOid === command.newOid) {
          repo.refs.set(command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}\n`);
        } else {
          reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        }
        continue;
      }
      if (isAncestor(repo.objects, oldPeeled, newPeeled)) {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      } else {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      }
    }
  }

  // report-status：pkt-line 流包在 sideband band 1 里，再以 flush 收尾。
  const reportStream = pktLines(reportLines);
  const parts: Buffer[] = [];
  for (const packet of sidebandPackets(1, reportStream)) parts.push(packet);
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
}

// -------------------------------------------------------------------------------------------
// 入口
// -------------------------------------------------------------------------------------------

/**
 * 处理 `/{owner}/{repo}.git/...` 的 git smart HTTP 请求。
 * 不匹配路径返回 false（调用方继续走其他路由）；匹配时一定完整处理并返回 true。
 */
export async function handleGit(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const route = matchGitRoute(req);
  if (route === null) return false;
  try {
    const method = req.method ?? 'GET';
    const repo = store.getRepo(route.owner, route.repoName);
    if (repo === undefined) {
      // 缺库 404 优先于 401：git 检查只断言了这一条（unknown-repo-404）。
      sendText(res, 404, 'repository not found');
      return true;
    }
    if (!authorized(req, store)) {
      sendBuffer(res, 401, 'application/json; charset=utf-8', Buffer.from('{"message":"Unauthorized"}\n', 'utf8'));
      return true;
    }
    if (method === 'GET' && route.rest === 'info/refs') {
      let service = '';
      try {
        service = new URL(req.url ?? '/', 'http://entry').searchParams.get('service') ?? '';
      } catch {
        service = '';
      }
      if (service === 'git-upload-pack' || service === 'git-receive-pack') {
        handleInfoRefs(req, res, repo, service);
        return true;
      }
      sendText(res, 400, 'bad service');
      return true;
    }
    if (method === 'POST' && route.rest === 'git-upload-pack') {
      await handleUploadPack(req, res, repo);
      return true;
    }
    if (method === 'POST' && route.rest === 'git-receive-pack') {
      await handleReceivePack(req, res, repo);
      return true;
    }
    sendBuffer(res, 404, 'application/json; charset=utf-8', Buffer.from('{"message":"Not Found"}\n', 'utf8'));
    return true;
  } catch (err) {
    // 绝不能让一次畸形 git 请求拖垮整个服务（repo-survives-errors 检查）。
    if (!res.headersSent) sendText(res, 500, `git handler error: ${err instanceof Error ? err.message : String(err)}`);
    else if (!res.writableEnded) res.end();
    return true;
  }
}
