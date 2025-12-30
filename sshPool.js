import { Client } from 'ssh2';
import fs from 'fs/promises';
import queue from './queue.js';

import config from './config.js';

class SSHConnectionPool {
    constructor() {
        this.pools = new Map(); // Map<serverAlias, Connection[]>
        this.activeConnections = new Map(); // Map<connectionId, {conn, serverAlias, inUse, lastUsed}>
        this.config = {
            maxConnections: config.maxConnectionsPerServer,
            minConnections: config.minConnectionsPerServer,
            idleTimeout: config.idleTimeout,
            keepAliveInterval: config.keepAliveInterval,
            connectionTimeout: 20000,
            retryAttempts: 3
        };

        // Nettoyage périodique des connexions inactives
        this.startCleanupInterval();
    }

    isConnectionReady(connId) {
        const connInfo = this.activeConnections.get(connId);
        if (!connInfo) return false;

        // Vérifier l'état réel
        return connInfo.conn._sock &&
            connInfo.conn._sock.readable &&
            this.activeConnections.get(connId)?.inUse !== undefined; // Basic check
    }

    // Obtenir ou créer une connexion
    async getConnection(serverAlias, serverConfig) {
        // Chercher une connexion disponible
        const pool = this.pools.get(serverAlias) || [];

        for (const connId of pool) {
            const connInfo = this.activeConnections.get(connId);
            if (connInfo && !connInfo.inUse && this.isConnectionReady(connId)) {
                connInfo.inUse = true;
                connInfo.lastUsed = Date.now();
                queue.log('info', `Réutilisation connexion SSH existante pour ${serverAlias}`);
                return { id: connId, client: connInfo.conn };
            }
        }

        // Si pas de connexion disponible, en créer une nouvelle
        if (pool.length < this.config.maxConnections) {
            const newConn = await this.createConnection(serverAlias, serverConfig);
            return newConn;
        }

        // Si pool plein, attendre qu'une connexion se libère
        queue.log('warn', `Pool SSH saturé pour ${serverAlias}, attente...`);
        return await this.waitForConnection(serverAlias, serverConfig);
    }

    // Créer une nouvelle connexion
    async createConnection(serverAlias, serverConfig) {
        const conn = new Client();
        const connId = `${serverAlias}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        return new Promise((resolve, reject) => {
            let retries = 0;

            const tryConnect = async () => {
                try {
                    const config = {
                        host: serverConfig.host,
                        port: 22,
                        username: serverConfig.user,
                        readyTimeout: this.config.connectionTimeout,
                        keepaliveInterval: this.config.keepAliveInterval,
                        keepaliveCountMax: 3
                    };

                    if (serverConfig.keyPath) {
                        config.privateKey = await fs.readFile(serverConfig.keyPath);
                    } else if (serverConfig.password) {
                        config.password = serverConfig.password;
                    }

                    conn.on('ready', () => {
                        queue.log('info', `Nouvelle connexion SSH établie pour ${serverAlias}`);

                        // Ajouter au pool
                        if (!this.pools.has(serverAlias)) {
                            this.pools.set(serverAlias, []);
                        }
                        this.pools.get(serverAlias).push(connId);

                        // Enregistrer la connexion
                        this.activeConnections.set(connId, {
                            conn,
                            serverAlias,
                            inUse: true,
                            lastUsed: Date.now(),
                            config: serverConfig
                        });

                        // Ajouter un flag pour vérifier si la connexion est prête
                        conn.isReady = true;

                        resolve({ id: connId, client: conn });
                    });

                    conn.on('error', (err) => {
                        conn.isReady = false;
                        if (retries < this.config.retryAttempts) {
                            retries++;
                            queue.log('warn', `Tentative ${retries}/${this.config.retryAttempts} de connexion à ${serverAlias}`);
                            setTimeout(tryConnect, 2000 * retries);
                        } else {
                            this.removeConnection(connId);
                            reject(new Error(`Impossible de se connecter à ${serverAlias}: ${err.message}`));
                        }
                    });

                    conn.on('close', () => {
                        conn.isReady = false;
                        this.removeConnection(connId);
                        queue.log('info', `Connexion SSH fermée pour ${serverAlias}`);
                    });

                    conn.connect(config);
                } catch (err) {
                    reject(err);
                }
            };

            tryConnect();
        });
    }

    // Libérer une connexion
    releaseConnection(connId) {
        const connInfo = this.activeConnections.get(connId);
        if (connInfo) {
            connInfo.inUse = false;
            connInfo.lastUsed = Date.now();
            queue.log('debug', `Connexion ${connId} libérée`);
        }
    }

    // Fermer une connexion spécifique
    closeConnection(connId) {
        const connInfo = this.activeConnections.get(connId);
        if (connInfo) {
            try {
                connInfo.conn.end();
            } catch (e) {
                // Ignorer les erreurs de fermeture
            }
            this.removeConnection(connId);
        }
    }

    // Retirer une connexion du pool
    removeConnection(connId) {
        const connInfo = this.activeConnections.get(connId);
        if (connInfo) {
            const pool = this.pools.get(connInfo.serverAlias);
            if (pool) {
                const index = pool.indexOf(connId);
                if (index > -1) {
                    pool.splice(index, 1);
                }
                if (pool.length === 0) {
                    this.pools.delete(connInfo.serverAlias);
                }
            }
            this.activeConnections.delete(connId);
        }
    }

    // Attendre qu'une connexion se libère
    async waitForConnection(serverAlias, serverConfig, timeout = 30000) {
        const startTime = Date.now();

        return new Promise((resolve, reject) => {
            const checkInterval = setInterval(async () => {
                // Vérifier le timeout
                if (Date.now() - startTime > timeout) {
                    clearInterval(checkInterval);
                    reject(new Error(`Timeout en attendant une connexion pour ${serverAlias}`));
                    return;
                }

                // Essayer d'obtenir une connexion
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
            }, 500);
        });
    }

    // Nettoyer les connexions inactives
    startCleanupInterval() {
        setInterval(() => {
            const now = Date.now();

            for (const [connId, connInfo] of this.activeConnections) {
                // Fermer les connexions inactives depuis trop longtemps
                if (!connInfo.inUse && (now - connInfo.lastUsed) > this.config.idleTimeout) {
                    const pool = this.pools.get(connInfo.serverAlias) || [];

                    // Garder au moins minConnections
                    if (pool.length > this.config.minConnections) {
                        queue.log('info', `Fermeture connexion inactive: ${connId}`);
                        this.closeConnection(connId);
                    }
                }

                // Vérifier que la connexion est toujours vivante
                if (!this.isConnectionReady(connId) && !connInfo.inUse) {
                    this.removeConnection(connId);
                }
            }
        }, 60000); // Vérifier toutes les minutes
    }

    // Obtenir les statistiques du pool
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
                    ready: info?.conn?.isReady || false,
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

    // Fermer toutes les connexions
    closeAll() {
        queue.log('info', 'Fermeture de toutes les connexions SSH...');
        for (const connId of this.activeConnections.keys()) {
            this.closeConnection(connId);
        }
    }
}

// Instance singleton
const sshPool = new SSHConnectionPool();

// Nettoyer à la fermeture du processus
process.on('SIGINT', () => {
    sshPool.closeAll();
    process.exit(0);
});

process.on('SIGTERM', () => {
    sshPool.closeAll();
    process.exit(0);
});

export default sshPool;
