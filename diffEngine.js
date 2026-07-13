import { createTwoFilesPatch } from 'diff';
import sourceAdapter from './sourceAdapter.js';
import fileOps from './fileOps.js';

/**
 * diffEngine — Comparaison fichier à fichier et dossier à dossier.
 * Fonctionne pour n'importe quelle combinaison local/remote via sourceAdapter.
 * Chaque résultat indique clairement l'origine (serveur + chemin) des sources.
 */

function countAddRemove(patch) {
    let added = 0, removed = 0;
    for (const line of patch.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    return { added, removed };
}

export default {
    /**
     * Compare deux fichiers. Retourne :
     *   { identical, source1, source2, hash1, hash2, diff?, added?, removed? }
     * source1/source2 = { server, path, label } (origine claire).
     */
    async diffFiles(s1, s2) {
        const f1 = await fileOps.readFile(s1);
        const f2 = await fileOps.readFile(s2);

        const origin1 = sourceAdapter.describe(s1);
        const origin2 = sourceAdapter.describe(s2);

        if (f1.hash === f2.hash) {
            return {
                identical: true,
                source1: origin1,
                source2: origin2,
                hash: f1.hash,
                stats: { size1: f1.size, size2: f2.size }
            };
        }

        const patch = createTwoFilesPatch(
            origin1.label, origin2.label,
            f1.content, f2.content,
            'source1', 'source2'
        );
        const { added, removed } = countAddRemove(patch);

        return {
            identical: false,
            source1: origin1,
            source2: origin2,
            hash1: f1.hash,
            hash2: f2.hash,
            added,
            removed,
            diff: patch,
            stats: { size1: f1.size, size2: f2.size }
        };
    },

    /**
     * Compare deux dossiers (arborescences). Retourne :
     *   { source1, source2, only_in_source1[], only_in_source2[],
     *     identical[], modified[{path, hash1, hash2, added, removed, diff?}], stats }
     * options = { recursive, compareContent, ignorePatterns, includeDiff }
     *   - compareContent (défaut true) : compare le contenu des fichiers communs par hash
     *   - includeDiff (défaut false)   : inclut le diff unifié pour chaque fichier modifié
     */
    async diffFolders(s1, s2, options = {}) {
        const recursive = options.recursive !== false;
        const compareContent = options.compareContent !== false;
        const includeDiff = options.includeDiff === true;
        const ignorePatterns = options.ignorePatterns || [];

        const origin1 = sourceAdapter.describe(s1);
        const origin2 = sourceAdapter.describe(s2);

        const list1 = await sourceAdapter.listFilesRecursive(s1, { recursive, ignorePatterns });
        const list2 = await sourceAdapter.listFilesRecursive(s2, { recursive, ignorePatterns });

        const set2 = new Set(list2);
        const set1 = new Set(list1);

        const only_in_source1 = list1.filter(p => !set2.has(p));
        const only_in_source2 = list2.filter(p => !set1.has(p));
        const common = list1.filter(p => set2.has(p));

        const identical = [];
        const modified = [];

        if (compareContent && common.length > 0) {
            // Lit les fichiers communs des deux côtés (batch par source pour perf remote)
            const hashes1 = await sourceAdapter.readManyHashes(s1, s1.path, common);
            const hashes2 = await sourceAdapter.readManyHashes(s2, s2.path, common);

            for (const rel of common) {
                const h1 = hashes1.get(rel);
                const h2 = hashes2.get(rel);
                if (h1.hash === h2.hash) {
                    identical.push(rel);
                } else {
                    const entry = { path: rel, hash1: h1.hash, hash2: h2.hash };
                    // diff textuel (best-effort ; ignore si binaire)
                    try {
                        const patch = createTwoFilesPatch(
                            `${origin1.label}/${rel}`, `${origin2.label}/${rel}`,
                            h1.content.toString('utf8'), h2.content.toString('utf8'),
                            'source1', 'source2'
                        );
                        const { added, removed } = countAddRemove(patch);
                        entry.added = added;
                        entry.removed = removed;
                        if (includeDiff) entry.diff = patch;
                    } catch (e) {
                        entry.note = 'diff indisponible (binaire ?)';
                    }
                    modified.push(entry);
                }
            }
        }

        return {
            source1: origin1,
            source2: origin2,
            only_in_source1,
            only_in_source2,
            identical,
            modified,
            stats: {
                total1: list1.length,
                total2: list2.length,
                onlyIn1: only_in_source1.length,
                onlyIn2: only_in_source2.length,
                identical: identical.length,
                modified: modified.length
            }
        };
    }
};
