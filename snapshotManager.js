import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { createTwoFilesPatch } from 'diff';
import config from './config.js';
import sourceAdapter from './sourceAdapter.js';

/**
 * snapshotManager — Versioning d'infrastructure (style gencodedoc).
 *
 * Capture l'état de fichiers/dossiers (local OU remote via sourceAdapter),
 * avec DÉDUPLICATION par contenu : stockage content-addressable façon git
 * (chaque contenu est stocké une seule fois, nommé par son hash SHA-256).
 *
 * Choix technique : PAS de better-sqlite3 (module natif fragile sur Node v24).
 * Stockage 100% fichiers JSON + blobs → robuste, inspectable, zéro dépendance native.
 *
 *   <dataDir>/infra_snapshots/
 *     ├── objects/<hash[0:2]>/<hash[2:]>   ← blobs dédupliqués
 *     └── index.json                        ← métadonnées des snapshots
 *
 * Le stockage est TOUJOURS local (sur l'hôte du MCP), que la source soit
 * local ou remote. Un snapshot remote peut être restauré vers local (backup)
 * et inversement (déploiement).
 */

const SNAP_DIR = path.join(config.dataDir, 'infra_snapshots');
const OBJECTS_DIR = path.join(SNAP_DIR, 'objects');
const INDEX_FILE = path.join(SNAP_DIR, 'index.json');

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function ensureDirs() {
    await fs.mkdir(OBJECTS_DIR, { recursive: true });
}

async function readIndex() {
    try {
        const data = await fs.readFile(INDEX_FILE, 'utf8');
        return JSON.parse(data);
    } catch {
        return { snapshots: [] };
    }
}

async function writeIndex(index) {
    await ensureDirs();
    await fs.writeFile(INDEX_FILE, JSON.stringify(index, null, 2));
}

function objectPath(hash) {
    return path.join(OBJECTS_DIR, hash.slice(0, 2), hash.slice(2));
}

async function objectExists(hash) {
    try {
        await fs.access(objectPath(hash));
        return true;
    } catch {
        return false;
    }
}

// Stocke un blob s'il n'existe pas déjà (déduplication). Retourne true si nouveau.
async function storeObject(hash, buffer) {
    if (await objectExists(hash)) return false;
    const p = objectPath(hash);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, buffer);
    return true;
}

async function readObject(hash) {
    return fs.readFile(objectPath(hash));
}

export default {
    /**
     * Crée un snapshot. Capture les fichiers listés (fichiers ou dossiers).
     * source  = { type:'local'|'remote', path? (ignoré), alias? }
     * paths   = liste de chemins ABSOLUS à capturer (fichiers ou dossiers)
     * options = { tag, message, recursive (défaut true), ignorePatterns }
     * Retourne { snapshotId, filesCount, totalBytes, newObjects, dedupedObjects }.
     */
    async createSnapshot(source, paths, options = {}) {
        await ensureDirs();
        const recursive = options.recursive !== false;
        const ignorePatterns = options.ignorePatterns || [];
        const origin = sourceAdapter.describe(source);

        // 1. Résout la liste complète des fichiers absolus à capturer
        const fileAbsPaths = [];
        for (const p of paths) {
            const kind = await sourceAdapter.exists({ ...source, path: p });
            if (!kind) throw new Error(`Chemin introuvable sur ${origin.server} : ${p}`);
            if (kind === 'd') {
                const rels = await sourceAdapter.listFilesRecursive(
                    { ...source, path: p }, { recursive, ignorePatterns }
                );
                const sep = source.type === 'local' ? path.sep : '/';
                for (const rel of rels) {
                    fileAbsPaths.push(p.replace(/\/+$/, '') + sep + rel);
                }
            } else {
                fileAbsPaths.push(p);
            }
        }

        // 2. Lit chaque fichier, stocke le blob (dedup), construit la file map
        const fileMap = [];
        let totalBytes = 0, newObjects = 0, dedupedObjects = 0;
        for (const absPath of fileAbsPaths) {
            const { content, mtime, size } = await sourceAdapter.readFile({ ...source, path: absPath });
            const hash = sha256(content);
            const isNew = await storeObject(hash, content);
            if (isNew) newObjects++; else dedupedObjects++;
            totalBytes += size;
            fileMap.push({ path: absPath, hash, size, mtime });
        }

        // 3. Enregistre le snapshot dans l'index
        const snapshotId = `snap_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        const index = await readIndex();
        index.snapshots.push({
            id: snapshotId,
            sourceType: source.type,
            sourceAlias: source.type === 'remote' ? source.alias : null,
            server: origin.server,
            timestamp: Date.now(),
            tag: options.tag || null,
            message: options.message || null,
            paths,
            files: fileMap
        });
        await writeIndex(index);

        return {
            snapshotId,
            server: origin.server,
            filesCount: fileMap.length,
            totalBytes,
            newObjects,
            dedupedObjects,
            tag: options.tag || null
        };
    },

    /**
     * Liste les snapshots. filter = { sourceType, sourceAlias, tag, limit }
     */
    async listSnapshots(filter = {}) {
        const index = await readIndex();
        let snaps = index.snapshots.slice().reverse(); // plus récents d'abord

        if (filter.sourceType) snaps = snaps.filter(s => s.sourceType === filter.sourceType);
        if (filter.sourceAlias) snaps = snaps.filter(s => s.sourceAlias === filter.sourceAlias);
        if (filter.tag) snaps = snaps.filter(s => s.tag === filter.tag);
        if (filter.limit) snaps = snaps.slice(0, filter.limit);

        // Résumé léger (sans la file map complète)
        return snaps.map(s => ({
            id: s.id,
            server: s.server,
            sourceType: s.sourceType,
            tag: s.tag,
            message: s.message,
            timestamp: s.timestamp,
            date: new Date(s.timestamp).toISOString(),
            paths: s.paths,
            filesCount: s.files.length
        }));
    },

    async _getSnapshot(id) {
        const index = await readIndex();
        const snap = index.snapshots.find(s => s.id === id || s.tag === id);
        if (!snap) throw new Error(`Snapshot '${id}' introuvable. Utilisez snapshot_list.`);
        return snap;
    },

    /**
     * Détails complets d'un snapshot (avec file map).
     */
    async getSnapshotDetails(id) {
        const snap = await this._getSnapshot(id);
        return snap;
    },

    /**
     * Compare deux snapshots (par chemin de fichier). Fonctionne même entre
     * un snapshot local et un snapshot remote.
     * options = { includeDiff }
     * Retourne { added[], removed[], modified[{path, hash1, hash2, added, removed, diff?}], identical, stats }.
     */
    async diffSnapshots(id1, id2, options = {}) {
        const includeDiff = options.includeDiff === true;
        const s1 = await this._getSnapshot(id1);
        const s2 = await this._getSnapshot(id2);

        const map1 = new Map(s1.files.map(f => [f.path, f]));
        const map2 = new Map(s2.files.map(f => [f.path, f]));

        const added = [];    // dans s2, pas dans s1
        const removed = [];  // dans s1, pas dans s2
        const modified = [];
        let identical = 0;

        for (const [p, f1] of map1) {
            if (!map2.has(p)) { removed.push(p); continue; }
            const f2 = map2.get(p);
            if (f1.hash === f2.hash) { identical++; continue; }
            const entry = { path: p, hash1: f1.hash, hash2: f2.hash };
            try {
                const c1 = (await readObject(f1.hash)).toString('utf8');
                const c2 = (await readObject(f2.hash)).toString('utf8');
                const patch = createTwoFilesPatch(`${id1}:${p}`, `${id2}:${p}`, c1, c2, 'snap1', 'snap2');
                let a = 0, r = 0;
                for (const line of patch.split('\n')) {
                    if (line.startsWith('+') && !line.startsWith('+++')) a++;
                    else if (line.startsWith('-') && !line.startsWith('---')) r++;
                }
                entry.added = a; entry.removed = r;
                if (includeDiff) entry.diff = patch;
            } catch {
                entry.note = 'diff indisponible (binaire ?)';
            }
            modified.push(entry);
        }
        for (const p of map2.keys()) {
            if (!map1.has(p)) added.push(p);
        }

        return {
            snapshot1: { id: s1.id, server: s1.server, date: new Date(s1.timestamp).toISOString() },
            snapshot2: { id: s2.id, server: s2.server, date: new Date(s2.timestamp).toISOString() },
            added, removed, modified,
            stats: {
                added: added.length,
                removed: removed.length,
                modified: modified.length,
                identical
            }
        };
    },

    /**
     * Restaure un snapshot vers une cible (local ou remote).
     * target  = { type, alias? }
     * options = { paths (filtre préfixe), dryRun (défaut true), force }
     * Retourne { dryRun, restored[], skipped[], errors[] }.
     */
    async restoreSnapshot(id, target, options = {}) {
        const dryRun = options.dryRun !== false;
        const snap = await this._getSnapshot(id);
        const targetOrigin = sourceAdapter.describe({ ...target, path: '/' });

        let files = snap.files;
        if (options.paths && options.paths.length > 0) {
            files = files.filter(f => options.paths.some(p => f.path === p || f.path.startsWith(p.replace(/\/+$/, '') + '/')));
        }

        const restored = [], skipped = [], errors = [];
        for (const f of files) {
            if (dryRun) {
                restored.push({ path: f.path, size: f.size });
                continue;
            }
            try {
                const buffer = await readObject(f.hash);
                await sourceAdapter.writeFile({ ...target, path: f.path }, buffer, { createDirs: true });
                restored.push({ path: f.path, size: f.size });
            } catch (e) {
                errors.push({ path: f.path, error: e.message });
            }
        }

        return {
            dryRun,
            target: targetOrigin.server,
            snapshotId: snap.id,
            restored,
            skipped,
            errors,
            stats: { total: files.length, restored: restored.length, errors: errors.length }
        };
    },

    /**
     * Supprime un snapshot et nettoie les blobs orphelins (dedup-aware).
     * Retourne { deleted, freedObjects, freedBytes }.
     */
    async deleteSnapshot(id) {
        const index = await readIndex();
        const idx = index.snapshots.findIndex(s => s.id === id || s.tag === id);
        if (idx === -1) throw new Error(`Snapshot '${id}' introuvable.`);

        const removed = index.snapshots.splice(idx, 1)[0];
        await writeIndex(index);

        // Collecte les hash encore référencés par les snapshots restants
        const stillUsed = new Set();
        for (const s of index.snapshots) {
            for (const f of s.files) stillUsed.add(f.hash);
        }

        // Supprime les blobs devenus orphelins
        let freedObjects = 0, freedBytes = 0;
        const uniqueHashes = new Set(removed.files.map(f => f.hash));
        for (const hash of uniqueHashes) {
            if (!stillUsed.has(hash)) {
                try {
                    const stat = await fs.stat(objectPath(hash));
                    freedBytes += stat.size;
                    await fs.unlink(objectPath(hash));
                    freedObjects++;
                } catch { /* déjà absent */ }
            }
        }

        return { deleted: true, snapshotId: removed.id, freedObjects, freedBytes };
    }
};
