import crypto from 'crypto';
import pathModule from 'path';
import { createTwoFilesPatch } from 'diff';
import sourceAdapter from './sourceAdapter.js';
import config from './config.js';

/**
 * fileOps — Opérations fichiers de haut niveau (local ET remote via sourceAdapter).
 *
 * Ajoute par-dessus sourceAdapter :
 *  - calcul de hash SHA-256 (protection contre modifications concurrentes)
 *  - génération de diff unifié
 *  - édition sécurisée (read → vérif hash → diff → write)
 *
 * Gère texte (utf8) et binaire (base64).
 */

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// E — Détection binaire (heuristique git) : un octet nul dans les 8000 premiers
// octets = contenu binaire. Rapide et fiable pour éviter la corruption utf8.
function looksBinary(buffer) {
    const len = Math.min(buffer.length, 8000);
    for (let i = 0; i < len; i++) {
        if (buffer[i] === 0) return true;
    }
    return false;
}

function resolvePath(sourcePath) {
    // Nettoie les traversées de répertoire
    const normalized = pathModule.normalize(sourcePath).replace(/\/$/, '');
    return normalized;
}

function validatePath(sourcePath) {
    if (!config.allowedRoots || config.allowedRoots.length === 0) {
        return; // Aucune restriction configurée
    }

    const resolved = resolvePath(sourcePath);
    const allowed = config.allowedRoots.some(root => {
        const normalRoot = pathModule.normalize(root).replace(/\/$/, '');
        return resolved === normalRoot || resolved.startsWith(normalRoot + '/');
    });

    if (!allowed) {
        const roots = config.allowedRoots.join(', ');
        throw new Error(`Accès refusé : '${resolved}' n'est pas dans les racines autorisées. Ajoutez le chemin à MCP_ALLOWED_ROOTS ou modifiez allowedRoots. Racines: ${roots}`);
    }
}

export default {
    /**
     * Lit un fichier et retourne { content, hash, mtime, size, encoding, ... }.
     * encoding 'utf8' → content est une string ; 'base64' → content encodé base64.
     *
     * E — Détection binaire auto : si encoding='utf8' mais le contenu est binaire
     *   (octet nul détecté), bascule automatiquement en base64 et signale via
     *   binaryDetected:true (évite la corruption silencieuse d'un .png/.gz lu en utf8).
     *   Désactivable avec options.autoDetect=false.
     *
     * options = { offset, limit, autoDetect } :
     *   - offset : ligne de départ (1-indexée) — lecture partielle PAR LIGNES (utf8)
     *   - limit  : nombre de lignes à retourner
     *   Mode consultation pour gros fichiers. Le HASH reste TOUJOURS celui du
     *   fichier COMPLET, pour que file_edit fonctionne (il relit le fichier entier).
     */
    async readFile(source, encoding = 'utf8', options = {}) {
        if (source.path) validatePath(source.path);
        const { content, mtime, size } = await sourceAdapter.readFile(source);
        // content est un Buffer ; le hash est TOUJOURS calculé sur le fichier complet
        const hash = sha256(content);
        // origin : d'où vient le fichier (serveur + chemin) — évite la confusion
        const origin = sourceAdapter.describe(source);

        // E — bascule auto utf8 → base64 si contenu binaire détecté
        const autoDetect = options.autoDetect !== false;
        let binaryDetected = false;
        let effectiveEncoding = encoding;
        if (encoding === 'utf8' && autoDetect && looksBinary(content)) {
            effectiveEncoding = 'base64';
            binaryDetected = true;
        }

        if (effectiveEncoding === 'base64') {
            // offset/limit n'ont pas de sens sur du binaire
            return {
                origin, content: content.toString('base64'), hash, mtime, size,
                encoding: 'base64',
                ...(binaryDetected ? { binaryDetected: true, note: "Contenu binaire détecté (octet nul) — retourné en base64 automatiquement." } : {})
            };
        }

        const full = content.toString('utf8');
        const { offset, limit } = options;

        // Lecture complète (défaut) → edit-safe
        if (offset === undefined && limit === undefined) {
            return { origin, content: full, hash, mtime, size, encoding: 'utf8' };
        }

        // Lecture partielle par lignes (mode consultation)
        const lines = full.split('\n');
        const totalLines = lines.length;
        const start = offset && offset > 0 ? offset - 1 : 0; // offset 1-indexé
        const end = limit ? start + limit : totalLines;
        const slice = lines.slice(start, end).join('\n');

        return {
            origin,
            content: slice,
            hash,          // hash du fichier COMPLET (protection file_edit)
            mtime,
            size,
            encoding,
            isPartial: true,
            offset: start + 1,
            limit: limit ?? (totalLines - start),
            totalLines,
            returnedLines: Math.min(end, totalLines) - start
        };
    },

    /**
     * Écrit un fichier. content est une string (utf8 ou base64 selon encoding).
     * options = { createDirs }
     * Retourne { hash, size }.
     */
    async writeFile(source, content, encoding = 'utf8', options = {}) {
        if (source.path) validatePath(source.path);
        const buffer = encoding === 'base64'
            ? Buffer.from(content, 'base64')
            : Buffer.from(content, 'utf8');
        const newHash = sha256(buffer);
        const origin = sourceAdapter.describe(source);

        // B — dryRun : montre ce qui serait écrit (diff vs existant) sans écrire
        if (options.dryRun) {
            let existed = false;
            let oldContent = '';
            try {
                const cur = await sourceAdapter.readFile(source);
                existed = true;
                oldContent = cur.content.toString('utf8');
            } catch { /* fichier inexistant → création */ }
            const patch = encoding === 'base64'
                ? '(binaire — diff non affiché)'
                : createTwoFilesPatch(origin.label, origin.label, oldContent, content, existed ? 'avant' : '(nouveau)', 'après');
            return { origin, dryRun: true, wouldWrite: true, existed, hash: newHash, size: buffer.length, diff: patch };
        }

        // C — backup auto avant écriture
        let backup = null;
        if (options.backup) backup = await this._backup(source, options.backupMessage);

        const result = await sourceAdapter.writeFile(source, buffer, options);
        return { origin, hash: newHash, size: result.size, ...(backup ? { backup } : {}) };
    },

    /**
     * C — Crée un snapshot du fichier avant modification (filet de sécurité).
     * Import dynamique de snapshotManager pour éviter tout couplage au chargement.
     * Retourne { snapshotId, tag } ou null si le fichier n'existe pas encore.
     */
    async _backup(source, message) {
        const exists = await sourceAdapter.exists(source);
        if (!exists) return null; // rien à sauvegarder (nouveau fichier)
        const { default: snapshotManager } = await import('./snapshotManager.js');
        const snapSource = source.type === 'local'
            ? { type: 'local' }
            : { type: 'remote', alias: source.alias };
        const tag = `auto-backup-${Date.now()}`;
        const res = await snapshotManager.createSnapshot(snapSource, [source.path], {
            tag,
            message: message || `Backup auto avant modification de ${source.path}`
        });
        return { snapshotId: res.snapshotId, tag };
    },

    /**
     * Édite un fichier avec protection par hash. DEUX MODES :
     *
     *  A) Chirurgical : { oldString, newString, replaceAll? }
     *     Remplace un bout précis. Sûr : erreur si oldString absent (OLDSTRING_NOT_FOUND)
     *     ou présent plusieurs fois sans replaceAll (MULTIPLE_MATCHES).
     *     Économe en tokens (pas besoin de renvoyer tout le fichier).
     *
     *  B) Complet : { newContent }  → remplace tout le contenu.
     *
     * Options communes : { expectedHash, encoding, dryRun, backup, backupMessage }
     *  - expectedHash : protège contre modification concurrente (HASH_MISMATCH)
     *  - dryRun       : retourne le diff sans écrire
     *  - backup       : snapshot du fichier avant écriture (undo via snapshot_restore)
     *
     * Retourne { origin, hash, diff, applied, added, removed, size, backup? }.
     */
    async editFile(source, params = {}, legacyExpectedHash, legacyEncoding) {
        // Rétrocompat : ancienne signature editFile(source, newContent, expectedHash, encoding)
        if (typeof params === 'string') {
            params = { newContent: params, expectedHash: legacyExpectedHash, encoding: legacyEncoding };
        }
        const encoding = params.encoding || 'utf8';
        const current = await this.readFile(source, encoding);

        // Protection hash (optionnelle mais recommandée)
        if (params.expectedHash && current.hash !== params.expectedHash) {
            const err = new Error(
                `Le fichier a été modifié depuis la dernière lecture (hash attendu: ${params.expectedHash}, actuel: ${current.hash}).`
            );
            err.code = 'HASH_MISMATCH';
            err.current = current;
            throw err;
        }

        // Détermine le nouveau contenu selon le mode
        let newContent;
        if (params.oldString !== undefined) {
            // Mode A — chirurgical
            const occurrences = current.content.split(params.oldString).length - 1;
            if (occurrences === 0) {
                const err = new Error(`oldString introuvable dans le fichier. Vérifiez le texte exact (espaces/indentation inclus).`);
                err.code = 'OLDSTRING_NOT_FOUND';
                throw err;
            }
            if (occurrences > 1 && !params.replaceAll) {
                const err = new Error(`oldString présent ${occurrences} fois. Précisez plus de contexte pour un match unique, ou utilisez replaceAll:true.`);
                err.code = 'MULTIPLE_MATCHES';
                err.occurrences = occurrences;
                throw err;
            }
            newContent = params.replaceAll
                ? current.content.split(params.oldString).join(params.newString ?? '')
                : current.content.replace(params.oldString, params.newString ?? '');
        } else if (params.newContent !== undefined) {
            // Mode B — remplacement complet
            newContent = params.newContent;
        } else {
            throw new Error("Aucune modification fournie : utilisez { oldString, newString } (chirurgical) ou { newContent } (complet).");
        }

        // Diff lisible
        const origin = sourceAdapter.describe(source);
        const patch = createTwoFilesPatch(origin.label, origin.label, current.content, newContent, 'avant', 'après');
        let added = 0, removed = 0;
        for (const line of patch.split('\n')) {
            if (line.startsWith('+') && !line.startsWith('+++')) added++;
            else if (line.startsWith('-') && !line.startsWith('---')) removed++;
        }

        // B — dryRun : preview sans écrire
        if (params.dryRun) {
            return { origin, dryRun: true, applied: false, diff: patch, added, removed };
        }

        // C — backup avant écriture
        let backup = null;
        if (params.backup) backup = await this._backup(source, params.backupMessage);

        const writeResult = await this.writeFile(source, newContent, encoding);

        return {
            origin,
            hash: writeResult.hash,
            diff: patch,
            applied: true,
            added,
            removed,
            size: writeResult.size,
            ...(backup ? { backup } : {})
        };
    }
};
