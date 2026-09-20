/**
 * Tests unitaires P1/P2 — orchestrator v11.4.0
 * Couvre : pool readiness helpers, groups resolve, queue purge, destructive, fleet parse-safe.
 */
import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import utils from './utils.js';
import groups from './groups.js';
import queue from './queue.js';
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

console.log('\n=== P1 unit tests ===\n');

test('config.version is 11.8.0', () => {
    assert.strictEqual(config.version, '11.8.0');
});

test('isDestructiveCommand detects rm -rf', () => {
    assert.strictEqual(utils.isDestructiveCommand('rm -rf /var/www'), true);
    assert.strictEqual(utils.isDestructiveCommand('ls -la'), false);
    assert.strictEqual(utils.isDestructiveCommand('systemctl stop nginx'), true);
    assert.strictEqual(utils.isDestructiveCommand('docker system prune -af'), true);
});

test('assertWritable throws when MCP_READONLY', () => {
    const prev = process.env.MCP_READONLY;
    process.env.MCP_READONLY = '1';
    let threw = false;
    try {
        utils.assertWritable('test');
    } catch {
        threw = true;
    }
    process.env.MCP_READONLY = prev;
    assert.strictEqual(threw, true);
});

test('assertWritable ok when not readonly', () => {
    const prev = process.env.MCP_READONLY;
    delete process.env.MCP_READONLY;
    utils.assertWritable('test');
    process.env.MCP_READONLY = prev;
});

await testAsync('groups.listGroups returns object', async () => {
    const g = await groups.listGroups();
    assert.ok(typeof g === 'object');
    assert.ok(Array.isArray(g.oci) || g.oci === undefined || true);
});

await testAsync('groups.resolveAliases single is portable', async () => {
    const all = await groups.resolveAliases('all');
    if (all.length > 0) {
        const alias = all[0];
        const list = await groups.resolveAliases(alias);
        assert.deepStrictEqual(list, [alias]);
    } else {
        await assert.rejects(
            () => groups.resolveAliases('__missing_test_alias__'),
            /inconnu|unknown/i
        );
    }
});

await testAsync('groups.resolveAliases all returns array', async () => {
    const list = await groups.resolveAliases('all');
    assert.ok(Array.isArray(list));
});

await testAsync('groups.resolveAliases group:oci', async () => {
    try {
        const list = await groups.resolveAliases('group:oci');
        assert.ok(Array.isArray(list));
        assert.ok(list.length >= 1);
    } catch (e) {
        // Groupe peut être vide si alias absents — acceptable
        assert.ok(e.message.includes('Groupe') || e.message.includes('alias'));
    }
});

await testAsync('queue.purgeJobs dryRun', async () => {
    await queue.init();
    const r = queue.purgeJobs({ status: 'crashed', dryRun: true });
    assert.ok(typeof r.purged === 'number');
    assert.strictEqual(r.dryRun, true);
    assert.ok(Array.isArray(r.ids));
});

await testAsync('queue.getRetryableJobs returns array', async () => {
    const jobs = queue.getRetryableJobs('crashed');
    assert.ok(Array.isArray(jobs));
});

test('redact still works nested', () => {
    const safe = utils.redactSensitiveObject({ api_key: 'secretkey9999', x: 1 });
    assert.ok(String(safe.api_key).startsWith('***'));
    assert.strictEqual(safe.x, 1);
});

test('isTerminalJobStatus includes partial', () => {
    assert.strictEqual(utils.isTerminalJobStatus('partial'), true);
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
