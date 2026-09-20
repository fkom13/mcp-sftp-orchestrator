/**
 * Tests unitaires v11.6 — projects, workSession, compact, sshTrust resolvePubkey
 */
import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import projects from './projects.js';
import workSession from './workSession.js';
import utils from './utils.js';
import sshTrust from './sshTrust.js';
import config from './config.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ❌ ${name}: ${e.message}`);
    }
}

async function testAsync(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ❌ ${name}: ${e.message}`);
    }
}

console.log('\n=== v11.6 unit tests ===\n');

test('config.version 11.8.0', () => {
    assert.strictEqual(config.version, '11.8.0');
});

test('compactResult truncates long strings', () => {
    const long = 'x'.repeat(1000);
    const c = utils.compactResult({ a: long, b: 1 }, { maxString: 50 });
    assert.ok(c.a.includes('…'));
    assert.strictEqual(c.b, 1);
});

test('wantsCompact respects param', () => {
    assert.strictEqual(utils.wantsCompact({ compact: true }), true);
    assert.strictEqual(utils.wantsCompact({ compact: false }), false);
});

await testAsync('projects set/get/resolve/remove', async () => {
    const name = `_test_proj_${Date.now()}`;
    // Use an existing alias from servers if any
    const servers = (await import('./servers.js')).default;
    const list = await servers.listServers();
    const alias = Object.keys(list)[0];
    if (!alias) {
        console.log('  ⚠️ skip project resolve (no servers)');
        return;
    }
    await projects.set(name, {
        description: 'unit test',
        local: { path: '/tmp/orch-test-local' },
        servers: {
            prod: { alias, path: '/tmp/orch-test-remote', runtime: { pm2: 'x' } }
        },
        ignore: ['node_modules']
    });
    const got = await projects.get(name);
    assert.strictEqual(got.description, 'unit test');
    const resolved = await projects.resolve(name);
    assert.strictEqual(resolved.remote.alias, alias);
    assert.strictEqual(resolved.local.type, 'local');
    await projects.remove(name);
    try {
        await projects.get(name);
        assert.fail('should be removed');
    } catch {
        /* expected */
    }
});

await testAsync('work_start / log / end', async () => {
    const s = await workSession.start({
        alias: null,
        project: 'unit',
        tag: 'test',
        message: 'unit session',
        snapshot: false
    });
    assert.ok(s.id.startsWith('ws_'));
    await workSession.log(s.id, { type: 'file_edit', path: '/tmp/x', detail: 'ok' });
    const ended = await workSession.end(s.id, { summary: 'done', note: false });
    assert.strictEqual(ended.status, 'closed');
    assert.ok(ended.events.length >= 2);
});

await testAsync('sshTrust resolvePubkey string', async () => {
    const pk = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJustATestKeyNotReal0000000000000000000000 unit@test';
    const resolved = await sshTrust.resolvePubkey({ type: 'string', pubkey: pk });
    assert.ok(resolved.startsWith('ssh-ed25519'));
});

await testAsync('sshTrust rejects private key content path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-key-'));
    const priv = path.join(dir, 'id_test');
    await fs.writeFile(priv, '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n');
    let threw = false;
    try {
        await sshTrust.resolvePubkey({ type: 'local_path', path: priv });
    } catch (e) {
        threw = true;
        assert.ok(/privée|private|pub/i.test(e.message));
    }
    assert.strictEqual(threw, true);
    await fs.rm(dir, { recursive: true, force: true });
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
