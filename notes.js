import fs from 'fs/promises';
import path from 'path';
import config from './config.js';

/**
 * notes — Mémoire contextuelle par serveur (protocole/particularités).
 *
 * Permet à l'IA pilote de ne pas se perdre dans un parc de nombreux serveurs :
 * chaque serveur peut porter une description, la liste de ses services critiques,
 * des avertissements (ex: "RAM 1Go, ne pas rebuild en prod"), des conventions
 * (chemins standards), et la trace de la dernière intervention.
 *
 * Stockage : <dataDir>/server_notes.json  (même pattern que servers.json).
 */

const NOTES_FILE = path.join(config.dataDir, 'server_notes.json');

async function readAll() {
    try {
        const data = await fs.readFile(NOTES_FILE, 'utf-8');
        return JSON.parse(data);
    } catch {
        return {};
    }
}

async function writeAll(notes) {
    await fs.mkdir(path.dirname(NOTES_FILE), { recursive: true });
    await fs.writeFile(NOTES_FILE, JSON.stringify(notes, null, 2));
}

export default {
    /**
     * Définit/met à jour la note d'un serveur (merge partiel : seuls les champs
     * fournis sont modifiés). Champs libres :
     *   description, services[], warnings[], conventions[], note (texte libre)
     * `last_intervention` est mis à jour automatiquement (timestamp + résumé).
     */
    async set(alias, fields = {}) {
        const notes = await readAll();
        const existing = notes[alias] || {};
        const merged = { ...existing };

        // Champs structurés (remplacés si fournis)
        for (const key of ['description', 'services', 'warnings', 'conventions', 'note']) {
            if (fields[key] !== undefined) merged[key] = fields[key];
        }
        // Trace d'intervention
        if (fields.intervention) {
            merged.last_intervention = {
                at: new Date().toISOString(),
                summary: fields.intervention
            };
        }
        merged.updatedAt = new Date().toISOString();

        notes[alias] = merged;
        await writeAll(notes);
        return { alias, note: merged };
    },

    /**
     * Récupère la note d'un serveur. Retourne null si absente.
     */
    async get(alias) {
        const notes = await readAll();
        return notes[alias] || null;
    },

    /**
     * Liste toutes les notes (vue d'ensemble du parc).
     */
    async list() {
        return await readAll();
    },

    /**
     * Supprime la note d'un serveur.
     */
    async remove(alias) {
        const notes = await readAll();
        if (!notes[alias]) return { removed: false, alias };
        delete notes[alias];
        await writeAll(notes);
        return { removed: true, alias };
    }
};
