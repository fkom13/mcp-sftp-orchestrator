/**
 * workSession.js — Sessions de travail (journal d'intervention).
 * Stockage atomique: <dataDir>/work_sessions.json
 */
import path from 'path';
import crypto from 'crypto';
import config from './config.js';
import notes from './notes.js';
import snapshotManager from './snapshotManager.js';
import jsonStore from './atomicJsonStore.js';

const SESSIONS_PATH = path.join(config.dataDir, 'work_sessions.json');
const EMPTY = { active: {}, history: [] };

const load = () => jsonStore.readJson(SESSIONS_PATH, EMPTY);

function trimHistory(data) {
    data.active ||= {};
    data.history ||= [];
    if (data.history.length > 100) data.history = data.history.slice(-100);
    return data;
}

export default {
    async start({ alias = null, project = null, tag = null, message = null, snapshot = false, paths = [] } = {}) {
        const id = `ws_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        const session = {
            id,
            alias,
            project,
            tag: tag || `work-${new Date().toISOString().slice(0, 10)}`,
            message: message || null,
            startedAt: new Date().toISOString(),
            events: [],
            snapshotId: null,
            status: 'active'
        };

        // Effet externe avant publication de la session. S'il échoue, on garde
        // l'information dans les events mais on ne laisse aucun état partiel.
        if (snapshot && alias && paths.length) {
            try {
                const snap = await snapshotManager.createSnapshot(
                    { type: 'remote', alias }, paths,
                    { tag: session.tag, message: message || `work_start ${id}` }
                );
                session.snapshotId = snap.snapshotId;
            } catch (e) {
                session.events.push({ at: new Date().toISOString(), type: 'snapshot_error', detail: e.message });
            }
        }

        await jsonStore.updateJson(SESSIONS_PATH, EMPTY, data => {
            trimHistory(data);
            data.active[id] = session;
            return data;
        });
        return session;
    },

    async log(id, event) {
        let count = 0;
        await jsonStore.updateJson(SESSIONS_PATH, EMPTY, data => {
            trimHistory(data);
            const session = data.active[id];
            if (!session) throw new Error(`Session '${id}' introuvable ou déjà fermée.`);
            session.events.push({ at: new Date().toISOString(), ...event });
            count = session.events.length;
            return data;
        });
        return { id, events: count };
    },

    async get(id) {
        const data = trimHistory(await load());
        if (data.active[id]) return data.active[id];
        const hist = data.history.find(s => s.id === id);
        if (hist) return hist;
        throw new Error(`Session '${id}' introuvable.`);
    },

    async list({ includeHistory = false } = {}) {
        const data = trimHistory(await load());
        const active = Object.values(data.active);
        if (!includeHistory) return { active, historyCount: data.history.length };
        return { active, history: data.history };
    },

    async end(id, { summary = null, note = true } = {}) {
        let closed;
        // Commit principal d'abord : une panne de notes ne doit jamais laisser
        // la session active alors que l'appel end a été accepté.
        await jsonStore.updateJson(SESSIONS_PATH, EMPTY, data => {
            trimHistory(data);
            const session = data.active[id];
            if (!session) throw new Error(`Session '${id}' introuvable ou déjà fermée.`);

            session.status = 'closed';
            session.endedAt = new Date().toISOString();
            session.summary = summary || session.message || `Session ${id} fermée`;
            session.events.push({ at: session.endedAt, type: 'end', detail: session.summary });
            if (note && session.alias) session.noteUpdated = null; // pending

            delete data.active[id];
            data.history.push(session);
            trimHistory(data);
            closed = structuredClone(session);
            return data;
        });

        if (note && closed.alias) {
            let noteUpdated = true;
            let noteError = null;
            try {
                await notes.set(closed.alias, {
                    intervention: `[${closed.tag}] ${closed.summary} (${closed.events.length} events)`
                });
            } catch (e) {
                noteUpdated = false;
                noteError = e.message;
            }

            // Compensation: enrichit l'historique sans rouvrir la session.
            await jsonStore.updateJson(SESSIONS_PATH, EMPTY, data => {
                trimHistory(data);
                const hist = data.history.find(s => s.id === id);
                if (hist) {
                    hist.noteUpdated = noteUpdated;
                    if (noteError) hist.noteError = noteError;
                    else delete hist.noteError;
                    closed = structuredClone(hist);
                }
                return data;
            });
        }

        return closed;
    }
};
