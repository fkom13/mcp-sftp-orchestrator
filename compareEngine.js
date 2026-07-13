import { createTwoFilesPatch } from 'diff';
import sourceAdapter from './sourceAdapter.js';
import fileOps from './fileOps.js';

/**
 * compareEngine — Comparaison d'un même fichier (ou de fichiers équivalents à
 * des emplacements différents) sur plusieurs sources.
 * Détecte les "drifts" de configuration entre serveurs (et localhost).
 *
 * Regroupe les sources par hash : chaque groupe = ensemble de sources ayant
 * un contenu identique. Plus d'un groupe → drift détecté.
 *
 * Chaque source peut porter :
 *   - un path différent d'une source à l'autre (ex: .bashrc ici, .zshrc là)
 *   - un label personnalisé (source.label) pour un affichage clair
 * Quand un drift est détecté, on peut générer le DIFF réel entre la version
 * de référence (groupe majoritaire) et chaque version divergente.
 */

export default {
    /**
     * Compare le contenu d'un fichier sur plusieurs sources.
     * sources = [{ type, path, alias?, label? }, ...] (min 2, local et/ou remote)
     * options = { includeContent: bool (défaut false), includeDiff: bool (défaut true) }
     *
     * Retourne :
     *   {
     *     drift: bool,                 // true si plus d'une version distincte
     *     reference: { label, sources } | null,  // groupe majoritaire (référence)
     *     groups: [{ hash, size, sources:[{server,path,label}], content?, isReference }],
     *     drifts: [{ from, to, added, removed, diff }],  // diff référence → chaque divergence
     *     errors: [{ source:{server,path,label}, error }],
     *     stats: { totalSources, successfulReads, uniqueVersions, unreadable }
     *   }
     */
    async compareSources(sources, options = {}) {
        const includeContent = options.includeContent === true;
        const includeDiff = options.includeDiff !== false; // défaut true
        const results = [];
        const errors = [];

        // Lecture de chaque source (séquentiel : simple et robuste ; le pool gère le reste)
        for (const source of sources) {
            const origin = sourceAdapter.describe(source);
            try {
                const file = await fileOps.readFile(source);
                results.push({ origin, hash: file.hash, size: file.size, content: file.content });
            } catch (e) {
                errors.push({ source: origin, error: e.message });
            }
        }

        // Regroupement par hash (on garde le contenu en interne pour le diff)
        const groupsMap = new Map();
        for (const r of results) {
            if (!groupsMap.has(r.hash)) {
                groupsMap.set(r.hash, {
                    hash: r.hash,
                    size: r.size,
                    sources: [],
                    _content: r.content // interne, retiré à la fin si includeContent=false
                });
            }
            groupsMap.get(r.hash).sources.push(r.origin);
        }

        const groups = Array.from(groupsMap.values())
            // le groupe le plus répandu en premier (majorité = référence probable)
            .sort((a, b) => b.sources.length - a.sources.length);

        const drift = groups.length > 1;

        // Marque le groupe de référence (majoritaire)
        groups.forEach((g, i) => { g.isReference = i === 0; });
        const reference = groups.length > 0
            ? { label: groups[0].sources[0].label, sources: groups[0].sources }
            : null;

        // Génère les diffs référence → chaque groupe divergent
        const drifts = [];
        if (drift && includeDiff) {
            const ref = groups[0];
            const refLabel = ref.sources[0].label;
            for (let i = 1; i < groups.length; i++) {
                const g = groups[i];
                const gLabel = g.sources[0].label;
                try {
                    const patch = createTwoFilesPatch(
                        refLabel, gLabel,
                        ref._content, g._content,
                        'référence', 'divergent'
                    );
                    let added = 0, removed = 0;
                    for (const line of patch.split('\n')) {
                        if (line.startsWith('+') && !line.startsWith('+++')) added++;
                        else if (line.startsWith('-') && !line.startsWith('---')) removed++;
                    }
                    drifts.push({
                        from: refLabel,
                        to: gLabel,
                        affectedSources: g.sources.map(s => s.label),
                        added,
                        removed,
                        diff: patch
                    });
                } catch (e) {
                    drifts.push({ from: refLabel, to: gLabel, note: 'diff indisponible (binaire ?)' });
                }
            }
        }

        // Nettoie le contenu interne (ou l'expose si demandé)
        for (const g of groups) {
            if (includeContent) g.content = g._content;
            delete g._content;
        }

        return {
            drift,
            reference,
            groups,
            drifts,
            errors,
            stats: {
                totalSources: sources.length,
                successfulReads: results.length,
                uniqueVersions: groups.length,
                unreadable: errors.length
            }
        };
    }
};
