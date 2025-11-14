import fs from 'fs/promises';
import path from 'path';
import config from './config.js';
const HISTORY_FILE_PATH = path.join(config.dataDir, 'history.json');

async function readHistory() {
    try {
        await fs.access(HISTORY_FILE_PATH);
        const data = await fs.readFile(HISTORY_FILE_PATH, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

async function writeHistory(history) {
    await fs.writeFile(HISTORY_FILE_PATH, JSON.stringify(history, null, 2));
}

async function logTask(jobDetails) {
    const history = await readHistory();
    const logEntry = {
        jobId: jobDetails.id,
        timestamp: new Date().toISOString(),
        type: jobDetails.type,
        alias: jobDetails.alias,
        command: jobDetails.type === 'ssh' ? jobDetails.cmd : `${jobDetails.direction} ${jobDetails.local} -> ${jobDetails.remote}`
    };
    history.unshift(logEntry); // Ajoute au début
    if (history.length > 500) { // Garde les 500 dernières commandes
        history.pop();
    }
    await writeHistory(history);
}

async function getHistory(filters = {}) {
    let history = await readHistory();
    if (filters.alias) {
        history = history.filter(log => log.alias === filters.alias);
    }
    return history;
}

export default { logTask, getHistory };
