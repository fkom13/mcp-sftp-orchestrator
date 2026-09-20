/**
 * projects.js — Registre sémantique projet ↔ serveur(s) ↔ paths local/remote.
 * Stockage atomique: <dataDir>/projects.json
 */
import path from 'path';
import config from './config.js';
import servers from './servers.js';
import jsonStore from './atomicJsonStore.js';

const PROJECTS_PATH = path.join(config.dataDir, 'projects.json');
const EMPTY = {};

const load = () => jsonStore.readJson(PROJECTS_PATH, EMPTY);

function validateName(name) {
    if (!name || !/^[a-zA-Z0-9_./-]+$/.test(name)) {
        throw new Error("Nom de projet invalide (alphanumérique, _ . / -).");
    }
}

export default {
    async list() {
        return load();
    },

    async get(name) {
        const all = await load();
        if (!all[name]) throw new Error(`Projet '${name}' introuvable. project_list pour voir.`);
        return { name, ...all[name] };
    },

    async set(name, fields = {}) {
        validateName(name);

        // Valider d'abord les aliases hors verrou projets afin de ne pas garder
        // le lock pendant une I/O vers le registre serveurs.
        let known = null;
        if (fields.servers !== undefined) known = await servers.listServers();

        let merged;
        await jsonStore.updateJson(PROJECTS_PATH, EMPTY, async (all) => {
            const existing = all[name] || {};
            merged = { ...existing };
            for (const key of ['description', 'ignore', 'local', 'servers', 'tags', 'network']) {
                if (fields[key] !== undefined) merged[key] = fields[key];
            }

            if (merged.servers && typeof merged.servers === 'object') {
                const serverMap = known || await servers.listServers();
                for (const [role, cfg] of Object.entries(merged.servers)) {
                    if (!cfg || !cfg.alias) throw new Error(`servers.${role}: 'alias' requis`);
                    if (!serverMap[cfg.alias]) throw new Error(`servers.${role}: alias '${cfg.alias}' inconnu (server_list)`);
                    if (!cfg.path) throw new Error(`servers.${role}: 'path' requis`);
                }
            }

            merged.updatedAt = new Date().toISOString();
            all[name] = merged;
            return all;
        });
        return { name, ...merged };
    },

    async remove(name) {
        await jsonStore.updateJson(PROJECTS_PATH, EMPTY, (all) => {
            if (!all[name]) throw new Error(`Projet '${name}' introuvable.`);
            delete all[name];
            return all;
        });
        return { success: true, message: `Projet '${name}' supprimé.` };
    },

    async resolve(name, role = null) {
        const project = await this.get(name);
        const ignore = project.ignore || ['node_modules', '.git', 'dist', 'coverage', '.env'];
        let remote = null;
        let runtime = null;
        let url = null;
        const serverEntries = project.servers || {};
        const roles = Object.keys(serverEntries);

        if (roles.length) {
            const useRole = role || (serverEntries.prod ? 'prod' : roles[0]);
            const cfg = serverEntries[useRole];
            if (!cfg) throw new Error(`Rôle '${useRole}' absent. Rôles: ${roles.join(', ')}`);
            remote = { type: 'remote', alias: cfg.alias, path: cfg.path, label: `${name}:${useRole}` };
            runtime = cfg.runtime || null;
            url = cfg.url || null;
        }

        const local = project.local?.path
            ? { type: 'local', path: project.local.path, label: `${name}:local` }
            : null;

        return {
            name,
            role: role || (serverEntries.prod ? 'prod' : roles[0] || null),
            local,
            remote,
            ignore,
            runtime,
            url,
            description: project.description || null,
            network: project.network || null,
            project
        };
    }
};
