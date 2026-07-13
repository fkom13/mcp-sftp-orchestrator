import { Client } from 'ssh2';
import fs from 'fs/promises';
import crypto from 'crypto';
import serverManager from './servers.js';

/**
 * shellSessions — Sessions shell PTY PERSISTANTES sur serveurs distants.
 *
 * Contrairement à task_exec (client.exec() = nouveau shell isolé à chaque appel),
 * ici on ouvre un vrai shell interactif (client.shell()) maintenu ouvert. Ainsi
 * `cd`, `export`, activations d'environnement, etc. PERSISTENT entre les commandes.
 *
 * === Détection de fin de commande (technique du marqueur echo-agnostique) ===
 * Après chaque commande, on envoie : printf '%s:%s\n' "MARKER" "$?"
 *   - La sortie RÉELLE du printf donne "MARKER:0" (exit code résolu en nombre).
 *   - La ligne de commande ÉCHO (si echo actif) contient "MARKER:$?" (littéral).
 *   - La regex /MARKER:(\d+)/ ne matche QUE la sortie réelle → jamais l'écho.
 * De plus on désactive l'écho du PTY (stty -echo) dès l'ouverture pour un parsing net.
 *
 * Chaque session utilise une connexion SSH DÉDIÉE (pas le pool) car le shell
 * monopolise le canal pour toute sa durée de vie.
 */

const DEFAULT_IDLE_TIMEOUT = 30 * 60 * 1000; // 30 min d'inactivité → fermeture auto
const DEFAULT_CMD_TIMEOUT = 300;             // secondes

class ShellSessionManager {
    constructor() {
        this.sessions = new Map(); // id → session
        this._startCleanup();
    }

    async _buildConnectConfig(alias) {
        const sc = await serverManager.getServer(alias);
        const config = {
            host: sc.host,
            port: sc.port || 22,
            username: sc.user,
            readyTimeout: 20000,
            keepaliveInterval: 30000,
            keepaliveCountMax: 3
        };
        if (sc.keyPath) {
            config.privateKey = await fs.readFile(sc.keyPath);
        } else if (sc.password) {
            config.password = sc.password;
        } else {
            throw new Error(`Aucune méthode d'authentification pour le serveur '${alias}'.`);
        }
        return config;
    }

    /**
     * Crée une session shell persistante.
     * options = { workdir, env: {K:V}, cmdTimeout }
     * Retourne { id, alias, ready }.
     */
    async createSession(alias, options = {}) {
        const config = await this._buildConnectConfig(alias);
        const conn = new Client();

        await new Promise((resolve, reject) => {
            let settled = false;
            conn.on('ready', () => { if (!settled) { settled = true; resolve(); } });
            conn.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
            conn.connect(config);
        });

        const stream = await new Promise((resolve, reject) => {
            conn.shell({ term: 'xterm', modes: {} }, (err, s) => err ? reject(err) : resolve(s));
        });

        const id = `sh_${alias}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        const session = {
            id, alias, conn, stream,
            buffer: '',
            createdAt: Date.now(),
            lastUsed: Date.now(),
            commandCount: 0,
            busy: false,
            closed: false,
            cmdTimeout: options.cmdTimeout || DEFAULT_CMD_TIMEOUT
        };

        stream.on('data', (d) => { session.buffer += d.toString('utf8'); });
        stream.on('close', () => { session.closed = true; });
        conn.on('error', () => { session.closed = true; });

        this.sessions.set(id, session);

        // Setup : désactive l'écho (parsing net) et vide le prompt
        await this._exec(session, "stty -echo 2>/dev/null; export PS1=''; export PS2=''", 15);

        // Répertoire de travail initial
        if (options.workdir) {
            const r = await this._exec(session, `cd ${this._shellQuote(options.workdir)}`, 15);
            if (r.exitCode !== 0) {
                this.closeSession(id);
                throw new Error(`Impossible de cd vers '${options.workdir}': ${r.output}`);
            }
        }

        // Variables d'environnement initiales
        if (options.env && typeof options.env === 'object') {
            for (const [k, v] of Object.entries(options.env)) {
                await this._exec(session, `export ${k}=${this._shellQuote(String(v))}`, 15);
            }
        }

        return { id, alias, ready: true };
    }

    _shellQuote(str) {
        // Quote sûr pour bash : entoure de ' et échappe les ' internes
        return `'${String(str).replace(/'/g, `'\\''`)}'`;
    }

    /**
     * Exécute une commande dans la session et attend le marqueur de fin.
     * Retourne { output, exitCode, timedOut }.
     */
    async _exec(session, command, timeoutSec) {
        const marker = `__ORCH_${crypto.randomBytes(8).toString('hex')}__`;
        const re = new RegExp(`${marker}:(-?\\d+)`);

        // Vide le buffer juste avant d'écrire (les commandes sont sérialisées via busy)
        session.buffer = '';

        // Commande utilisateur, puis marqueur avec code de sortie de CETTE commande
        session.stream.write(`${command}\n`);
        session.stream.write(`printf '%s:%s\\n' "${marker}" "$?"\n`);

        const timeoutMs = timeoutSec === 0 ? 0 : (timeoutSec || DEFAULT_CMD_TIMEOUT) * 1000;
        const start = Date.now();

        return new Promise((resolve) => {
            const check = setInterval(() => {
                const m = session.buffer.match(re);
                if (m) {
                    clearInterval(check);
                    const exitCode = parseInt(m[1], 10);
                    const raw = session.buffer.slice(0, m.index);
                    resolve({ output: this._clean(raw, marker).trim(), exitCode, timedOut: false });
                } else if (session.closed) {
                    clearInterval(check);
                    resolve({ output: this._clean(session.buffer, marker).trim(), exitCode: null, timedOut: false, closed: true });
                } else if (timeoutMs > 0 && Date.now() - start > timeoutMs) {
                    clearInterval(check);
                    // Tente de débloquer la commande (Ctrl-C) sans tuer la session
                    try { session.stream.write('\x03'); } catch (e) { /* ignore */ }
                    resolve({ output: this._clean(session.buffer, marker).trim(), exitCode: null, timedOut: true });
                }
            }, 100);
        });
    }

    // Nettoie la sortie : strip séquences ANSI (couleurs, bracketed-paste \x1b[?2004h/l),
    // strip les \r du PTY, retire les lignes écho/marqueur.
    _clean(output, marker) {
        return output
            // eslint-disable-next-line no-control-regex
            .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') // séquences CSI ANSI
            .replace(/\r/g, '')
            .split('\n')
            .filter(line => !line.includes(marker) && !line.includes("printf '%s:%s"))
            .join('\n');
    }

    /**
     * Exécute une commande dans une session existante (état persistant).
     */
    async execInSession(id, command, timeoutSec) {
        const session = this.sessions.get(id);
        if (!session) throw new Error(`Session '${id}' introuvable. Utilisez shell_list pour voir les sessions actives.`);
        if (session.closed) {
            this.sessions.delete(id);
            throw new Error(`Session '${id}' est fermée (connexion perdue). Créez-en une nouvelle avec shell_create.`);
        }
        if (session.busy) throw new Error(`Session '${id}' occupée : une seule commande à la fois par session.`);

        session.busy = true;
        session.lastUsed = Date.now();
        session.commandCount++;
        try {
            return await this._exec(session, command, timeoutSec ?? session.cmdTimeout);
        } finally {
            session.busy = false;
        }
    }

    /**
     * Liste les sessions actives avec leur état.
     */
    listSessions() {
        const now = Date.now();
        return Array.from(this.sessions.values()).map(s => ({
            id: s.id,
            alias: s.alias,
            ageSeconds: Math.round((now - s.createdAt) / 1000),
            idleSeconds: Math.round((now - s.lastUsed) / 1000),
            commandCount: s.commandCount,
            busy: s.busy,
            closed: s.closed
        }));
    }

    /**
     * Ferme proprement une session.
     */
    closeSession(id) {
        const session = this.sessions.get(id);
        if (!session) throw new Error(`Session '${id}' introuvable.`);
        try { session.stream.end('exit\n'); } catch (e) { /* ignore */ }
        try { session.conn.end(); } catch (e) { /* ignore */ }
        this.sessions.delete(id);
        return { closed: true, id };
    }

    _startCleanup() {
        setInterval(() => {
            const now = Date.now();
            for (const [id, s] of this.sessions) {
                if (s.closed || (!s.busy && (now - s.lastUsed) > DEFAULT_IDLE_TIMEOUT)) {
                    try { this.closeSession(id); } catch (e) { /* ignore */ }
                }
            }
        }, 60000);
    }

    closeAll() {
        for (const id of [...this.sessions.keys()]) {
            try { this.closeSession(id); } catch (e) { /* ignore */ }
        }
    }
}

export default new ShellSessionManager();
