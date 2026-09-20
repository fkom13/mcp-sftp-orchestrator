import { Client } from 'ssh2';
import fs from 'fs/promises';
import queue from './queue.js';
import utils from './utils.js';
import config from './config.js';

/**
 * Pool de connexions SSH persistantes.
 * v11.4.0 : listeners non empilés sur retry, flag ready fiable, port configurable.
 */
class SSHConnectionPool {
    constructor() {
        this.pools = new Map(); // Map<serverAlias, connId[]>
        this.activeConnections = new Map(); // Map<connId, {conn, serverAlias, inUse, lastUsed, ready}>
        this.config = {
            maxConnections: config.maxConnectionsPerServer,
            minConnections: config.minConnectionsPerServer,
            idleTimeout: config.idleTimeout,
            keepAliveInterval: config.keepAliveInterval,
            connectionTimeout: 20000,
            retryAttempts: 3
        };
        this.startCleanupInterval();
    }

    isConnectionReady(connId) {
        const connInfo = this.activeConnections.get(connId);
        if (!connInfo || !connInfo.ready || connInfo.closed) return false;
        const sock = connInfo.conn && connInfo.conn._sock;
        if (!sock) return false;
        // Socket encore ouvert et lisible
        if (sock.destroyed || sock.readyState === 'closed') return false;
        return sock.readable !== false;
    }

    async getConnection(serverAlias, serverConfig) {
        const pool = this.pools.get(serverAlias) || [];

        for (const connId of pool) {
            const connInfo = this.activeConnections.get(connId);
            if (connInfo && !connInfo.inUse && this.isConnectionReady(connId)) {
                connInfo.inUse = true;
                connInfo.lastUsed = Date.now();
                queue.log('info', `Réutilisation connexion SSH existante pour ${serverAlias}`);
                return { id: connId, client: connInfo.conn };
            }
            // Connexion morte dans le pool → purge
            if (connInfo && !connInfo.inUse && !this.isConnectionReady(connId)) {
                this.removeConnection(connId);
            }
        }

        const currentPool = this.pools.get(serverAlias) || [];
        if (currentPool.length < this.config.maxConnections) {
            return await this.createConnection(serverAlias, serverConfig);
        }

        queue.log('warn', `Pool SSH saturé pour ${serverAlias}, attente...`);
        return await this.waitForConnection(serverAlias, serverConfig);
    }

    async createConnection(serverAlias, serverConfig) {
        const connId = `${serverAlias}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
        let lastError = null;

        for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
            try {
                const conn = await this._connectOnce(serverAlias, serverConfig, connId);
                return conn;
            } catch (err) {
                lastError = err;
                queue.log('warn', `Tentative ${attempt}/${this.config.retryAttempts} de connexion à ${serverAlias}: ${err.message}`);
                if (attempt < this.config.retryAttempts) {
                    await new Promise(r => setTimeout(r, 2000 * attempt));
                }
            }
        }

        this.removeConnection(connId);
        throw new Error(`Impossible de se connecter à ${serverAlias}: ${lastError?.message || 'erreur inconnue'}`);
    }

    /**
     * Une seule tentative = un nouveau Client + listeners uniques (pas d'empilement).
     */
    _connectOnce(serverAlias, serverConfig, connId) {
        return new Promise(async (resolve, reject) => {
            const conn = new Client();
            let settled = false;

            const fail = (err) => {
                if (settled) return;
                settled = true;
                try { conn.removeAllListeners(); conn.end(); } catch { /* ignore */ }
                reject(err instanceof Error ? err : new Error(String(err)));
            };

            const succeed = () => {
                if (settled) return;
                settled = true;
                queue.log('info', `Nouvelle connexion SSH établie pour ${serverAlias}`);

                if (!this.pools.has(serverAlias)) this.pools.set(serverAlias, []);
                const pool = this.pools.get(serverAlias);
                if (!pool.includes(connId)) pool.push(connId);

                this.activeConnections.set(connId, {
                    conn,
                    serverAlias,
                    inUse: true,
                    lastUsed: Date.now(),
                    ready: true,
                    closed: false,
                    config: serverConfig
                });

                resolve({ id: connId, client: conn });
            };

            conn.once('ready', succeed);
            conn.once('error', (err) => fail(err));
            conn.on('close', () => {
                const info = this.activeConnections.get(connId);
                if (info) {
                    info.ready = false;
                    info.closed = true;
                }
                this.removeConnection(connId);
                queue.log('info', `Connexion SSH fermée pour ${serverAlias}`);
            });
            conn.on('end', () => {
                const info = this.activeConnections.get(connId);
                if (info) {
                    info.ready = false;
                    info.closed = true;
                }
            });

            try {
                const connectConfig = {
                    host: serverConfig.host,
                    port: utils.resolveSshPort(serverConfig),
                    username: serverConfig.user,
                    readyTimeout: this.config.connectionTimeout,
                    keepaliveInterval: this.config.keepAliveInterval,
                    keepaliveCountMax: 3
                };

                if (serverConfig.keyPath) {
                    connectConfig.privateKey = await fs.readFile(serverConfig.keyPath);
                } else if (serverConfig.password) {
                    connectConfig.password = serverConfig.password;
                } else {
                    return fail(new Error(`Aucune méthode d'authentification pour '${serverAlias}'`));
                }

                conn.connect(connectConfig);
            } catch (err) {
                fail(err);
            }
        });
    }

    releaseConnection(connId) {
        const connInfo = this.activeConnections.get(connId);
        if (connInfo) {
            connInfo.inUse = false;
            connInfo.lastUsed = Date.now();
            queue.log('debug', `Connexion ${connId} libérée`);
        }
    }

    closeConnection(connId) {
        const connInfo = this.activeConnections.get(connId);
        if (connInfo) {
            try {
                connInfo.ready = false;
                connInfo.conn.end();
            } catch { /* ignore */ }
            this.removeConnection(connId);
        }
    }

    removeConnection(connId) {
        const connInfo = this.activeConnections.get(connId);
        if (connInfo) {
            const pool = this.pools.get(connInfo.serverAlias);
            if (pool) {
                const index = pool.indexOf(connId);
                if (index > -1) pool.splice(index, 1);
                if (pool.length === 0) this.pools.delete(connInfo.serverAlias);
            }
            this.activeConnections.delete(connId);
        }
    }

    async waitForConnection(serverAlias, serverConfig, timeout = 30000) {
        const startTime = Date.now();

        return new Promise((resolve, reject) => {
            const checkInterval = setInterval(() => {
                if (Date.now() - startTime > timeout) {
                    clearInterval(checkInterval);
                    reject(new Error(`Timeout en attendant une connexion pour ${serverAlias}`));
                    return;
                }

                const pool = this.pools.get(serverAlias) || [];
                for (const connId of pool) {
                    const connInfo = this.activeConnections.get(connId);
                    if (connInfo && !connInfo.inUse && this.isConnectionReady(connId)) {
                        clearInterval(checkInterval);
                        connInfo.inUse = true;
                        connInfo.lastUsed = Date.now();
                        resolve({ id: connId, client: connInfo.conn });
                        return;
                    }
                }

                // Slot libre → créer
                if (pool.length < this.config.maxConnections) {
                    clearInterval(checkInterval);
                    this.createConnection(serverAlias, serverConfig).then(resolve).catch(reject);
                }
            }, 500);
        });
    }

    startCleanupInterval() {
        setInterval(() => {
            const now = Date.now();
            for (const [connId, connInfo] of [...this.activeConnections.entries()]) {
                if (!connInfo.inUse && (now - connInfo.lastUsed) > this.config.idleTimeout) {
                    const pool = this.pools.get(connInfo.serverAlias) || [];
                    if (pool.length > this.config.minConnections) {
                        queue.log('info', `Fermeture connexion inactive: ${connId}`);
                        this.closeConnection(connId);
                        continue;
                    }
                }
                if (!this.isConnectionReady(connId) && !connInfo.inUse) {
                    this.removeConnection(connId);
                }
            }
        }, 60000);
    }

    getStats() {
        const stats = {
            totalConnections: this.activeConnections.size,
            byServer: {}
        };

        for (const [serverAlias, pool] of this.pools) {
            const connections = pool.map(connId => {
                const info = this.activeConnections.get(connId);
                return {
                    id: connId,
                    inUse: info?.inUse || false,
                    ready: this.isConnectionReady(connId),
                    lastUsed: info?.lastUsed
                };
            });

            stats.byServer[serverAlias] = {
                total: connections.length,
                inUse: connections.filter(c => c.inUse).length,
                available: connections.filter(c => !c.inUse && c.ready).length,
                connections
            };
        }

        return stats;
    }

    closeAll() {
        queue.log('info', 'Fermeture de toutes les connexions SSH...');
        for (const connId of [...this.activeConnections.keys()]) {
            this.closeConnection(connId);
        }
    }
}

const sshPool = new SSHConnectionPool();
export default sshPool;
