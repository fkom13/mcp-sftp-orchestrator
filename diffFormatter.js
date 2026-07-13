/**
 * diffFormatter — Rendu lisible des diffs pour les clients MCP.
 *
 * Les outils renvoient des métadonnées JSON (hash, applied, added/removed...)
 * dont l'IA a besoin de façon fiable. Mais un diff unifié brut dans un champ
 * JSON est illisible (\n échappés). Ce module produit :
 *   - un bloc markdown ```diff (coloré dans les clients, "comme les vrais tools")
 *   - un résumé concis (+X / -Y lignes)
 *
 * Convention de sortie des outils : content = [ blocMarkdown, blocJSON ].
 */

// Nettoie un patch unifié (createTwoFilesPatch) : retire le bruit d'en-tête
// (Index:/===) tout en gardant ---/+++/@@ et le corps.
function cleanPatch(patch) {
    return patch
        .split('\n')
        .filter(line => !line.startsWith('Index: ') && !/^=+$/.test(line))
        .join('\n')
        .trim();
}

// Compte les lignes ajoutées/supprimées (hors en-têtes +++/---)
function countAddRemove(patch) {
    let added = 0, removed = 0;
    for (const line of patch.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    return { added, removed };
}

// Barre visuelle proportionnelle (ex: +++++-- )
function bar(added, removed, width = 20) {
    const total = added + removed;
    if (total === 0) return '';
    const plus = Math.round((added / total) * width);
    const minus = width - plus;
    return '+'.repeat(plus) + '-'.repeat(minus);
}

export default {
    countAddRemove,

    /**
     * Formate un patch unifié en markdown.
     * opts = { title }
     * Retourne { markdown, summary, added, removed }.
     */
    format(patch, opts = {}) {
        const cleaned = cleanPatch(patch);
        const { added, removed } = countAddRemove(patch);
        const summary = `+${added} / -${removed} ligne${(added + removed) > 1 ? 's' : ''}`;

        let markdown = '';
        if (opts.title) markdown += `### ${opts.title}\n`;
        markdown += `**${summary}**  \`${bar(added, removed)}\`\n\n`;
        markdown += '```diff\n' + cleaned + '\n```';

        return { markdown, summary, added, removed };
    },

    /**
     * Construit une réponse MCP à deux blocs : markdown lisible + JSON metadata.
     * - markdown : string déjà formatée (via format())
     * - meta     : objet metadata (sera JSON.stringify)
     * Le champ 'diff' brut est retiré du JSON (déjà rendu en markdown) pour
     * éviter la duplication et économiser des tokens.
     */
    response(markdown, meta) {
        const clean = { ...meta };
        delete clean.diff; // le diff est dans le bloc markdown
        return {
            content: [
                { type: "text", text: markdown },
                { type: "text", text: JSON.stringify(clean, null, 2) }
            ]
        };
    },

    /**
     * Résumé d'un diff de dossiers/snapshots (listes de fichiers) en markdown.
     * groups = { added:[], removed:[], modified:[{path, added, removed}], identical? }
     */
    formatFileList(groups, opts = {}) {
        const lines = [];
        if (opts.title) lines.push(`### ${opts.title}`);
        const a = groups.added?.length || 0;
        const r = groups.removed?.length || 0;
        const m = groups.modified?.length || 0;
        lines.push(`**${m} modifié(s), ${a} ajouté(s), ${r} supprimé(s)**\n`);

        if (m > 0) {
            lines.push('**Modifiés :**');
            for (const f of groups.modified) {
                const p = f.path || f;
                const delta = (f.added !== undefined) ? ` (+${f.added}/-${f.removed})` : '';
                lines.push(`- \`${p}\`${delta}`);
            }
            lines.push('');
        }
        if (a > 0) {
            lines.push('**Ajoutés :**');
            for (const p of groups.added) lines.push(`- \`${p}\``);
            lines.push('');
        }
        if (r > 0) {
            lines.push('**Supprimés :**');
            for (const p of groups.removed) lines.push(`- \`${p}\``);
            lines.push('');
        }
        return lines.join('\n').trim();
    }
};
