import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

// --- Début de la Correction ---
// Trouve le chemin du .env par rapport à l'emplacement de ce script, et non du répertoire de travail
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });
// --- Fin de la Correction ---

// Analyser les arguments de la ligne de commande (ex: --data-dir=...)
const args = process.argv.slice(2).reduce((acc, arg) => {
    const [key, value] = arg.split('=');
    if (key && value) {
        acc[key.replace(/^--/, '')] = value;
    }
    return acc;
}, {});

const config = {
    dataDir: args['data-dir'] || process.env.MCP_DATA_DIR || path.join(os.homedir(), '.config', 'mcp-orchestrator'),
    
    // Timeouts en millisecondes (plus cohérent)
    syncTimeout: parseInt(args['sync-timeout'] || process.env.MCP_SYNC_TIMEOUT_S || '30', 10) * 1000,
    defaultCommandTimeout: parseInt(process.env.MCP_DEFAULT_CMD_TIMEOUT_MS || '300000', 10),
    interactiveCommandTimeout: parseInt(process.env.MCP_INTERACTIVE_CMD_TIMEOUT_MS || '120000', 10),
    
    // Configuration Pool SSH
    maxConnectionsPerServer: parseInt(process.env.MAX_CONNECTIONS_PER_SERVER || '5', 10),
    minConnectionsPerServer: parseInt(process.env.MIN_CONNECTIONS_PER_SERVER || '1', 10),
    idleTimeout: parseInt(process.env.IDLE_TIMEOUT || '300000', 10),
    keepAliveInterval: parseInt(process.env.KEEP_ALIVE_INTERVAL || '30000', 10),
    
    // Configuration Queue
    maxQueueSize: parseInt(process.env.MAX_QUEUE_SIZE || '1000', 10),
    saveInterval: parseInt(process.env.SAVE_INTERVAL || '5000', 10),
    historyRetention: parseInt(process.env.HISTORY_RETENTION || '2678400000', 10), // 31 jours
};

// Validation
if (config.syncTimeout < 1000) {
    if (process.env.MCP_DEBUG === 'true') {
        console.error('⚠️ syncTimeout trop court, minimum 1000ms');
    }
    config.syncTimeout = 1000;
}

if (config.maxConnectionsPerServer < config.minConnectionsPerServer) {
    if (process.env.MCP_DEBUG === 'true') {
        console.error('⚠️ maxConnections < minConnections, ajustement automatique');
    }
    config.maxConnectionsPerServer = config.minConnectionsPerServer;
}

// Créer le dossier de données s'il n'existe pas
fs.mkdirSync(config.dataDir, { recursive: true });

export default config;
