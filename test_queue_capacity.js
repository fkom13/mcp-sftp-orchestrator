import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import queue from './queue.js';
import config from './config.js';

function resetQueue() {
    const q = queue.getQueue();
    for (const id of Object.keys(q)) delete q[id];
}

function seed(status, count, prefix = status) {
    const q = queue.getQueue();
    const now = Date.now();
    for (let i = 0; i < count; i++) {
        q[`${prefix}-${i}`] = {
            id: `${prefix}-${i}`,
            type: 'test',
            status,
            createdAt: new Date(now - i * 1000),
            updatedAt: new Date(now - i * 1000),
            retryCount: 0,
            maxRetries: 3
        };
    }
}

try {
    resetQueue();
    seed('completed', 1000);
    const fromCompleted = queue.addJob({ type: 'test', status: 'pending' });
    assert.ok(fromCompleted.id);
    assert.strictEqual(queue.getActiveCount(), 1);
    assert.ok(Object.keys(queue.getQueue()).length <= 301);

    resetQueue();
    seed('crashed', 1000);
    const fromCrashed = queue.addJob({ type: 'test', status: 'pending' });
    assert.ok(fromCrashed.id);
    assert.strictEqual(queue.getActiveCount(), 1);
    assert.ok(Object.keys(queue.getQueue()).length <= 301);

    resetQueue();
    seed('pending', 1000);
    assert.throws(
        () => queue.addJob({ type: 'test', status: 'pending' }),
        /Queue active pleine/
    );

    resetQueue();
    seed('pending', 1000);
    queue.getQueue()['retry-source'] = {
        id: 'retry-source',
        type: 'test',
        status: 'crashed',
        createdAt: new Date(),
        updatedAt: new Date(),
        retryCount: 0,
        maxRetries: 3,
        canRetry: true
    };
    await assert.rejects(
        () => queue.retryJob('retry-source'),
        /Queue active pleine/
    );

    resetQueue();
    seed('completed', 350);
    queue.cleanOldJobs();
    assert.strictEqual(
        Object.values(queue.getQueue()).filter(j => ['completed','failed','crashed','partial'].includes(j.status)).length,
        300
    );

    resetQueue();
    const persisted = {};
    const now = Date.now();
    persisted['was-running'] = {
        id: 'was-running',
        type: 'test',
        status: 'running',
        createdAt: new Date(now - 5000).toISOString(),
        updatedAt: new Date(now - 5000).toISOString(),
        retryCount: 0,
        maxRetries: 3
    };
    for (let i = 0; i < 350; i++) {
        persisted[`done-${i}`] = {
            id: `done-${i}`,
            type: 'test',
            status: 'completed',
            createdAt: new Date(now - i * 1000).toISOString(),
            updatedAt: new Date(now - i * 1000).toISOString(),
            retryCount: 0,
            maxRetries: 3
        };
    }
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.writeFile(path.join(config.dataDir, 'queue.json'), JSON.stringify(persisted, null, 2));

    await queue.init();
    assert.strictEqual(queue.getQueue()['was-running']?.status, 'crashed');
    assert.strictEqual(queue.getActiveCount(), 0);
    assert.ok(Object.keys(queue.getQueue()).length <= 300);

    await queue.saveQueue();
    const saved = JSON.parse(await fs.readFile(path.join(config.dataDir, 'queue.json'), 'utf8'));
    assert.ok(Object.keys(saved).length <= 300);
    assert.ok(Object.values(saved).every(job => !['pending','running'].includes(job.status)));

    console.log('QUEUE_CAPACITY_TEST_OK', {
        maxActiveJobs: config.maxActiveJobs,
        maxTaskHistory: config.maxTaskHistory,
        restoredCount: Object.keys(queue.getQueue()).length
    });
    process.exit(0);
} catch (error) {
    console.error('QUEUE_CAPACITY_TEST_FAILED', error);
    process.exit(1);
}
