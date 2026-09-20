/**
 * Hardening regression tests — v11.6.1 candidate
 * - MCP_ALLOWED_ROOTS applies below sourceAdapter, including symlink escape
 * - server_to_server supports files + directories
 * - force:false prevents overwrite server_to_server
 * - mutating MCP handlers are wired through readonly guards
 */
import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import config from './config.js';
import sourceAdapter from './sourceAdapter.js';
import sftp from './sftp.js';
import queue from './queue.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.error(`  ❌ ${name}: ${e.stack || e.message}`); }
}

console.log('\n=== Orchestrator hardening tests ===\n');

await test('MCP_ALLOWED_ROOTS permits inside path and blocks outside', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-out-'));
  const old = [...config.allowedRoots];
  try {
    config.allowedRoots = [root];
    sourceAdapter.assertLocalPathAllowed(path.join(root, 'ok.txt'));
    assert.throws(() => sourceAdapter.assertLocalPathAllowed(path.join(outside, 'no.txt')), /hors MCP_ALLOWED_ROOTS|refusé/i);
  } finally {
    config.allowedRoots = old;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

await test('MCP_ALLOWED_ROOTS blocks symlink escape', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-out-'));
  const link = path.join(root, 'escape');
  await fs.symlink(outside, link);
  const old = [...config.allowedRoots];
  try {
    config.allowedRoots = [root];
    assert.throws(() => sourceAdapter.assertLocalPathAllowed(path.join(link, 'secret.txt')), /hors MCP_ALLOWED_ROOTS|refusé/i);
  } finally {
    config.allowedRoots = old;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

const originals = {
  exists: sourceAdapter.exists,
  readFile: sourceAdapter.readFile,
  writeFile: sourceAdapter.writeFile,
  listFilesRecursive: sourceAdapter.listFilesRecursive
};

function installVirtualRemote(entries) {
  const map = new Map(Object.entries(entries));
  sourceAdapter.exists = async ({ alias, path: p }) => {
    const key = `${alias}:${p}`;
    if (map.has(key)) return map.get(key).kind;
    // Treat a directory as existing if children exist.
    const prefix = key.replace(/\/+$/, '') + '/';
    for (const k of map.keys()) if (k.startsWith(prefix)) return 'd';
    return false;
  };
  sourceAdapter.readFile = async ({ alias, path: p }) => {
    const e = map.get(`${alias}:${p}`);
    if (!e || e.kind === 'd') throw new Error(`not a file: ${alias}:${p}`);
    const content = Buffer.from(e.content ?? '');
    return { content, size: content.length, mtime: 1 };
  };
  sourceAdapter.writeFile = async ({ alias, path: p }, content) => {
    map.set(`${alias}:${p}`, { kind: '-', content: Buffer.from(content).toString() });
    return { size: Buffer.byteLength(content) };
  };
  sourceAdapter.listFilesRecursive = async ({ alias, path: p }) => {
    const prefix = `${alias}:${p.replace(/\/+$/, '')}/`;
    const out = [];
    for (const [k, v] of map) {
      if (v.kind === 'd' || !k.startsWith(prefix)) continue;
      out.push(k.slice(prefix.length));
    }
    return out.sort();
  };
  return map;
}

async function runS2S(details) {
  const job = queue.addJob({ type: 'sftp', direction: 'server_to_server', status: 'pending', ...details });
  await sftp.executeTransfer(job.id);
  return queue.getJob(job.id);
}

await test('server_to_server copies a file and counts 1/1', async () => {
  const map = installVirtualRemote({ 'src:/a.txt': { kind: '-', content: 'hello' } });
  const job = await runS2S({ alias: 'dst', source_alias: 'src', local: '/a.txt', remote: '/b.txt', force: false });
  assert.strictEqual(job.status, 'completed');
  assert.match(job.output, /1\/1/);
  assert.strictEqual(map.get('dst:/b.txt').content, 'hello');
});

await test('server_to_server force:false refuses overwrite and counts failure', async () => {
  installVirtualRemote({
    'src:/a.txt': { kind: '-', content: 'new' },
    'dst:/b.txt': { kind: '-', content: 'old' }
  });
  const job = await runS2S({ alias: 'dst', source_alias: 'src', local: '/a.txt', remote: '/b.txt', force: false });
  assert.strictEqual(job.status, 'failed');
  assert.match(job.output, /0\/1/);
  assert.match(JSON.stringify(job.failedFiles), /force:true/i);
});

await test('server_to_server recursively copies a directory', async () => {
  const map = installVirtualRemote({
    'src:/tree': { kind: 'd' },
    'src:/tree/a.txt': { kind: '-', content: 'A' },
    'src:/tree/sub/b.txt': { kind: '-', content: 'B' }
  });
  const job = await runS2S({ alias: 'dst', source_alias: 'src', local: '/tree', remote: '/copy', force: false });
  assert.strictEqual(job.status, 'completed');
  assert.match(job.output, /2\/2/);
  assert.strictEqual(map.get('dst:/copy/a.txt').content, 'A');
  assert.strictEqual(map.get('dst:/copy/sub/b.txt').content, 'B');
  assert.ok(job.warnings?.length >= 1); // explicit non-bit-exact caveat
});

await test('readonly guards cover critical mutating handlers', async () => {
  const code = await fs.readFile(new URL('./server.js', import.meta.url), 'utf8');
  const expectations = {
    task_transfer: 'guardTransferWritable',
    task_transfer_multi: 'guardTransferWritable',
    task_exec_interactive: 'guardAliasWritable',
    task_exec_sequence: 'guardAliasWritable',
    shell_exec: 'guardAliasWritable',
    snapshot_restore: 'guardWritable',
    snapshot_delete: 'guardWritable',
    api_add: 'guardWritable',
    api_remove: 'guardWritable',
    tmux_create: 'guardAliasWritable',
    tmux_exec: 'guardAliasWritable',
    tmux_kill: 'guardAliasWritable',
    tunnel_create: 'guardWritable',
    tunnel_close: 'guardWritable'
  };
  const starts = [...code.matchAll(/server\.registerTool\(\s*["']([^"']+)["']/g)];
  const bodies = new Map();
  starts.forEach((m, i) => bodies.set(m[1], code.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : code.length)));
  for (const [name, marker] of Object.entries(expectations)) {
    assert.ok(bodies.get(name)?.includes(marker), `${name} missing ${marker}`);
  }
});

Object.assign(sourceAdapter, originals);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed ? 1 : 0);
