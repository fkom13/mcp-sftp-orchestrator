import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import micromatch from 'micromatch';
import serverManager from './servers.js';
import sshPool from './sshPool.js';
import { z } from 'zod';

/**
 * sourceAdapter — Abstraction unifiée local/remote.
 *
 * Une "source" est un objet : { type: 'local'|'remote', path, alias? }
 *  - type 'local'  → utilise fs directement (ZÉRO SSH, sur le PC hôte du MCP)
 *  - type 'remote' → réutilise une connexion du POOL SSH (sshPool) et ouvre un
 *                    canal SFTP dessus (pas de reconnexion TCP/handshake par op).
 *
 * v10.2.0 : le transport remote passe par le pool SSH partagé (perf : plus de
 * reconnexion à chaque opération). Un wrapper promisifié reproduit fidèlement
 * l'API de ssh2-sftp-client précédemment utilisée (get/put/stat/exists/list/mkdir),
 * pour zéro régression sur les couches supérieures (fileOps, diffEngine, snapshots).
 *
 * Toutes les opérations fichiers de haut niveau s'appuient sur ce module.
 */

// Schéma Zod partagé pour une "source" (local ou remote). Défini ici pour
// cohabiter avec le traitement (sourceAdapter) et être importé par server.js.
const sourceSchema = z.object({
    type: z.enum(['local', 'remote']).describe("'local' = PC hôte du MCP (sans SSH), 'remote' = serveur distant (SFTP)"),
    path: z.string().describe("Chemin absolu du fichier"),
    alias: z.string().optional().describe("Alias du serveur (requis si type='remote')"),
    label: z.string().optional().describe("Nom lisible optionnel pour cette source (ex: 'nginx-prod'). Utile pour comparer des fichiers à des emplacements différents.")
});

// Enrobe le sous-système SFTP brut de ssh2 en une API Promise identique à
// celle de ssh2-sftp-client (sous-ensemble utilisé ici).
function promisifySftp(rawSftp) {
    return {
        // Lit un fichier → Buffer
        get(remotePath) {
            return new Promise((resolve, reject) => {
                rawSftp.readFile(remotePath, (err, data) => err ? reject(err) : resolve(data));
            });
        },
        // Écrit un Buffer
        put(buffer, remotePath) {
            return new Promise((resolve, reject) => {
                rawSftp.writeFile(remotePath, buffer, (err) => err ? reject(err) : resolve());
            });
        },
        // stat → { size, modifyTime(ms), accessTime(ms), isDirectory, isFile, mode }
        stat(remotePath) {
            return new Promise((resolve, reject) => {
                rawSftp.stat(remotePath, (err, s) => {
                    if (err) return reject(err);
                    resolve({
                        size: s.size,
                        modifyTime: (s.mtime || 0) * 1000, // ssh2 = secondes → ms
                        accessTime: (s.atime || 0) * 1000,
                        isDirectory: s.isDirectory(),
                        isFile: s.isFile(),
                        mode: s.mode
                    });
                });
            });
        },
        // exists → false | 'd' | 'l' | '-'
        exists(remotePath) {
            return new Promise((resolve) => {
                rawSftp.lstat(remotePath, (err, s) => {
                    if (err) return resolve(false);
                    if (s.isDirectory()) return resolve('d');
                    if (typeof s.isSymbolicLink === 'function' && s.isSymbolicLink()) return resolve('l');
                    return resolve('-');
                });
            });
        },
        // list → [{ name, type:'d'|'l'|'-' }]
        list(remotePath) {
            return new Promise((resolve, reject) => {
                rawSftp.readdir(remotePath, (err, entries) => {
                    if (err) return reject(err);
                    resolve(entries.map(e => {
                        let type = '-';
                        const a = e.attrs;
                        if (a && typeof a.isDirectory === 'function') {
                            if (a.isDirectory()) type = 'd';
                            else if (typeof a.isSymbolicLink === 'function' && a.isSymbolicLink()) type = 'l';
                        } else if (e.longname && e.longname[0] === 'd') {
                            type = 'd';
                        } else if (e.longname && e.longname[0] === 'l') {
                            type = 'l';
                        }
                        return { name: e.filename, type };
                    }));
                });
            });
        },
        // mkdir(dir, recursive) — recursive implémenté (ssh2 brut ne le fait pas)
        async mkdir(dir, recursive) {
            const makeOne = (p) => new Promise((resolve, reject) => {
                rawSftp.mkdir(p, (err) => {
                    // ignore "existe déjà" (Failure générique de SFTP)
                    if (err && !/failure|exist/i.test(err.message || '')) return reject(err);
                    resolve();
                });
            });
            if (!recursive) return makeOne(dir);
            const parts = dir.split('/').filter(Boolean);
            let cur = dir.startsWith('/') ? '' : '.';
            for (const part of parts) {
                cur = cur === '' ? '/' + part : cur + '/' + part;
                await makeOne(cur).catch(() => { /* niveau intermédiaire déjà présent */ });
            }
        }
    };
}

// Réutilise une connexion du pool SSH, ouvre un canal SFTP dessus, exécute fn,
// ferme le canal (PAS la connexion) et rend la connexion au pool.
async function withSftp(alias, fn) {
    const serverConfig = await serverManager.getServer(alias);
    const conn = await sshPool.getConnection(alias, serverConfig);
    let rawSftp = null;
    try {
        rawSftp = await new Promise((resolve, reject) => {
            conn.client.sftp((err, sftp) => err ? reject(err) : resolve(sftp));
        });
        return await fn(promisifySftp(rawSftp));
    } finally {
        try { if (rawSftp) rawSftp.end(); } catch (e) { /* canal déjà fermé */ }
        sshPool.releaseConnection(conn.id);
    }
}

// Décrit une source de façon claire (évite que l'IA se perde entre serveurs)
// Retourne { server, type, path, label }
//   server : 'localhost' (local) ou l'alias du serveur (remote)
//   label  : label personnalisé si fourni (source.label), sinon "server:path"
//            Utile quand on compare des fichiers à des emplacements différents
//            (ex: .bashrc sur un VPS vs .zshrc sur un autre → labels "shell-vps1"/"shell-vps2")
function describe(source) {
    const server = source.type === 'local' ? 'localhost' : source.alias;
    return {
        server,
        type: source.type,
        path: source.path,
        label: source.label || `${server}:${source.path}`
    };
}

// Valide la structure d'une source
function validateSource(source) {
    if (!source || typeof source !== 'object') {
        throw new Error("Source invalide : objet attendu { type, path, alias? }");
    }
    if (source.type !== 'local' && source.type !== 'remote') {
        throw new Error(`Type de source invalide : '${source.type}'. Attendu 'local' ou 'remote'.`);
    }
    if (!source.path) {
        throw new Error("Source invalide : 'path' est requis.");
    }
    if (source.type === 'remote' && !source.alias) {
        throw new Error("Source remote invalide : 'alias' est requis quand type='remote'.");
    }
}

export { sourceSchema };

export default {
    /**
     * Décrit une source : { server, type, path, label }.
     * server = 'localhost' ou alias serveur. Utile pour indiquer clairement
     * l'origine d'un fichier lu (évite la confusion entre serveurs).
     */
    describe,

    /**
     * Lit un fichier. Retourne { content: Buffer, mtime, size }.
     */
    async readFile(source) {
        validateSource(source);
        if (source.type === 'local') {
            const content = await fs.readFile(source.path);
            const stat = await fs.stat(source.path);
            return { content, mtime: stat.mtimeMs, size: stat.size };
        }
        return withSftp(source.alias, async (sftp) => {
            const content = await sftp.get(source.path); // Buffer
            const stat = await sftp.stat(source.path);
            return { content, mtime: stat.modifyTime, size: stat.size };
        });
    },

    /**
     * Écrit un fichier. contentBuffer doit être un Buffer.
     * options = { createDirs: bool (défaut true) }
     * Retourne { size }.
     */
    async writeFile(source, contentBuffer, options = {}) {
        validateSource(source);
        const createDirs = options.createDirs !== false;

        if (source.type === 'local') {
            if (createDirs) {
                await fs.mkdir(path.dirname(source.path), { recursive: true });
            }
            await fs.writeFile(source.path, contentBuffer);
            const stat = await fs.stat(source.path);
            return { size: stat.size };
        }

        return withSftp(source.alias, async (sftp) => {
            if (createDirs) {
                const dir = path.posix.dirname(source.path);
                if (dir && dir !== '/' && dir !== '.') {
                    const exists = await sftp.exists(dir);
                    if (!exists) await sftp.mkdir(dir, true);
                }
            }
            await sftp.put(contentBuffer, source.path);
            const stat = await sftp.stat(source.path);
            return { size: stat.size };
        });
    },

    /**
     * Retourne les stats d'un fichier/dossier (format brut fs ou sftp).
     */
    async stat(source) {
        validateSource(source);
        if (source.type === 'local') {
            return fs.stat(source.path);
        }
        return withSftp(source.alias, async (sftp) => sftp.stat(source.path));
    },

    /**
     * Vérifie l'existence d'un chemin. Retourne false, 'd', '-', 'l'.
     */
    async exists(source) {
        validateSource(source);
        if (source.type === 'local') {
            try {
                const stat = await fs.stat(source.path);
                return stat.isDirectory() ? 'd' : '-';
            } catch {
                return false;
            }
        }
        return withSftp(source.alias, async (sftp) => sftp.exists(source.path));
    },

    /**
     * Liste le contenu d'un dossier. Retourne [{ name, type }].
     * type: 'd' (dossier), '-' (fichier), 'l' (lien).
     */
    async listDir(source) {
        validateSource(source);
        if (source.type === 'local') {
            const entries = await fs.readdir(source.path, { withFileTypes: true });
            return entries.map(e => ({
                name: e.name,
                type: e.isDirectory() ? 'd' : e.isSymbolicLink() ? 'l' : '-'
            }));
        }
        return withSftp(source.alias, async (sftp) => {
            const list = await sftp.list(source.path);
            return list.map(e => ({ name: e.name, type: e.type }));
        });
    },

    /**
     * Liste récursivement tous les FICHIERS d'un dossier.
     * Retourne un tableau de chemins RELATIFS (posix, ex: "conf/nginx.conf").
     * options = { recursive: bool (défaut true), ignorePatterns: string[] }
     * ignorePatterns : motifs glob (micromatch) testés contre chaque chemin relatif
     *   ET chaque segment (ex: 'node_modules' ignore tout le dossier).
     *
     * Pour remote : tout le parcours se fait dans UNE SEULE connexion SFTP.
     */
    async listFilesRecursive(source, options = {}) {
        validateSource(source);
        const recursive = options.recursive !== false;
        const ignore = options.ignorePatterns || [];

        const shouldIgnore = (relPath) => {
            if (ignore.length === 0) return false;
            const segments = relPath.split('/');
            // ignore si le chemin complet matche, ou si un segment matche
            return micromatch.isMatch(relPath, ignore) ||
                segments.some(seg => micromatch.isMatch(seg, ignore));
        };

        if (source.type === 'local') {
            const results = [];
            const walk = async (absDir, relDir) => {
                const entries = await fs.readdir(absDir, { withFileTypes: true });
                for (const e of entries) {
                    const relPath = relDir ? `${relDir}/${e.name}` : e.name;
                    if (shouldIgnore(relPath)) continue;
                    if (e.isDirectory()) {
                        if (recursive) await walk(path.join(absDir, e.name), relPath);
                    } else if (e.isFile()) {
                        results.push(relPath);
                    }
                }
            };
            await walk(source.path, '');
            return results.sort();
        }

        // Remote : une seule connexion SFTP pour tout le walk
        return withSftp(source.alias, async (sftp) => {
            const results = [];
            const walk = async (absDir, relDir) => {
                const list = await sftp.list(absDir);
                for (const e of list) {
                    const relPath = relDir ? `${relDir}/${e.name}` : e.name;
                    if (shouldIgnore(relPath)) continue;
                    if (e.type === 'd') {
                        if (recursive) await walk(path.posix.join(absDir, e.name), relPath);
                    } else if (e.type === '-') {
                        results.push(relPath);
                    }
                }
            };
            await walk(source.path, '');
            return results.sort();
        });
    },

    /**
     * Lit plusieurs fichiers d'un dossier remote dans UNE connexion SFTP.
     * relPaths : chemins relatifs à basePath. Retourne Map<relPath, {content:Buffer, hash}>.
     * Pour local, lit simplement via fs (pas de coût connexion).
     */
    async readManyHashes(source, basePath, relPaths) {
        validateSource(source);
        const result = new Map();

        if (source.type === 'local') {
            for (const rel of relPaths) {
                const buf = await fs.readFile(path.join(basePath, rel));
                result.set(rel, { content: buf, hash: crypto.createHash('sha256').update(buf).digest('hex') });
            }
            return result;
        }

        return withSftp(source.alias, async (sftp) => {
            for (const rel of relPaths) {
                const buf = await sftp.get(path.posix.join(basePath, rel));
                result.set(rel, { content: buf, hash: crypto.createHash('sha256').update(buf).digest('hex') });
            }
            return result;
        });
    }
};
