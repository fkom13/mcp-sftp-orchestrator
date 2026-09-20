import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import jsonStore from './atomicJsonStore.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-json-store-'));
const file = path.join(dir, 'counter.json');
try {
    await jsonStore.writeJsonAtomic(file, { n: 0 }, { backup: false });

    await Promise.all(Array.from({ length: 50 }, () =>
        jsonStore.updateJson(file, { n: 0 }, data => {
            data.n += 1;
            return data;
        })
    ));

    const after = await jsonStore.readJson(file, { n: -1 });
    assert.strictEqual(after.n, 50, '50 concurrent updates must all survive');
    JSON.parse(await fs.readFile(file, 'utf8'));

    // Crée un backup valide, puis corrompt le primary : readJson doit récupérer .bak.
    await jsonStore.writeJsonAtomic(file, { n: 51 });
    await fs.writeFile(file, '{broken-json');
    const recovered = await jsonStore.readJson(file, { n: -1 });
    assert.strictEqual(recovered.n, 50, 'backup recovery should return previous valid generation');

    const mode = (await fs.stat(`${file}.bak`)).mode & 0o777;
    assert.ok(mode === 0o600 || mode === 0o644, `unexpected backup mode ${mode.toString(8)}`);

    console.log('ATOMIC_JSON_STORE_CONCURRENCY_OK');
} finally {
    await fs.rm(dir, { recursive: true, force: true });
}
