import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

/**
 * AtomicJsonStore — primitive commune pour les petits registres JSON du MCP.
 *
 * Garanties intra-processus :
 * - update(file) sérialise read -> mutate -> write par fichier ;
 * - écriture via temp unique + fsync + rename atomique ;
 * - backup .bak du dernier fichier valide avant remplacement ;
 * - permissions du temp forcées à 0600 (les registres peuvent contenir des secrets) ;
 * - un JSON corrompu n'est plus silencieusement remplacé par {} : tentative .bak,
 *   puis erreur explicite si aucune copie valide n'existe.
 *
 * Ce verrou protège les appels concurrents du même process MCP. Pour le SaaS
 * multi-instance, la persistance devra migrer vers DB/transaction ou un lock distribué.
 */

const tails = new Map();

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

async function withLock(file, fn) {
    const key = path.resolve(file);
    const prev = tails.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tail = prev.catch(() => {}).then(() => gate);
    tails.set(key, tail);

    await prev.catch(() => {});
    try {
        return await fn();
    } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
    }
}

async function parseFile(file) {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text);
}

async function readJson(file, fallback, { createIfMissing = false } = {}) {
    try {
        return await parseFile(file);
    } catch (err) {
        if (err?.code === 'ENOENT') {
            const value = clone(fallback);
            if (createIfMissing) await writeJsonAtomic(file, value, { backup: false });
            return value;
        }

        // Parse/I/O error : récupérer la dernière copie saine si possible.
        try {
            return await parseFile(`${file}.bak`);
        } catch {
            const wrapped = new Error(`JSON store illisible: ${file} (${err.message})`);
            wrapped.code = 'JSON_STORE_CORRUPT';
            wrapped.cause = err;
            throw wrapped;
        }
    }
}

async function writeJsonAtomic(file, value, { backup = true } = {}) {
    await fs.mkdir(path.dirname(file), { recursive: true });

    if (backup) {
        try { await fs.copyFile(file, `${file}.bak`); } catch (e) {
            if (e?.code !== 'ENOENT') throw e;
        }
    }

    const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    let handle = null;
    try {
        handle = await fs.open(tmp, 'w', 0o600);
        await handle.writeFile(JSON.stringify(value, null, 2));
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(tmp, file);
    } catch (err) {
        if (handle) await handle.close().catch(() => {});
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw err;
    }
}

async function ensureJson(file, fallback) {
    return withLock(file, async () => readJson(file, fallback, { createIfMissing: true }));
}

async function updateJson(file, fallback, mutator, options = {}) {
    return withLock(file, async () => {
        const current = await readJson(file, fallback, { createIfMissing: false });
        const next = await mutator(current);
        const value = next === undefined ? current : next;
        await writeJsonAtomic(file, value, options);
        return value;
    });
}

export default {
    withLock,
    readJson,
    writeJsonAtomic,
    ensureJson,
    updateJson
};

export { withLock, readJson, writeJsonAtomic, ensureJson, updateJson };
