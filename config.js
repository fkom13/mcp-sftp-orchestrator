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
    // La hiérarchie reste la même : les arguments en ligne de commande écrasent le .env, qui écrase le défaut.
    dataDir: args['data-dir'] || process.env.MCP_DATA_DIR || path.join(os.homedir(), '.config', 'mcp-orchestrator'),
    syncTimeout: parseInt(args['sync-timeout'] || process.env.MCP_SYNC_TIMEOUT_S || '10', 10) * 1000,
    defaultCommandTimeout: parseInt(process.env.MCP_DEFAULT_CMD_TIMEOUT_MS || '300000', 10),
    interactiveCommandTimeout: parseInt(process.env.MCP_INTERACTIVE_CMD_TIMEOUT_MS || '120000', 10)
};

// Créer le dossier de données s'il n'existe pas
fs.mkdirSync(config.dataDir, { recursive: true });

export default config;
