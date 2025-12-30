import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import config from './config.js';

const QUEUE_FILE = path.join(config.dataDir, 'queue.json');
const QUEUE_BACKUP = path.join(config.dataDir, 'queue.backup.json');
const SAVE_INTERVAL = 5000;
const MAX_QUEUE_SIZE = 1000;

// ✅ Mode silencieux par défaut (logs désactivés sauf si MCP_DEBUG=true)
const SILENT_MODE = process.env.MCP_DEBUG !== 'true';

const jobQueue = {};
const logHistory = [];
const MAX_LOGS = 500;

let saveTimer = null;
let isDirty = false;

// Charger la queue au démarrage
async function loadQueue() {
    try {
        const data = await fs.readFile(QUEUE_FILE, 'utf-8');
        const savedQueue = JSON.parse(data);

        for (const [id, job] of Object.entries(savedQueue)) {
            if (job.createdAt) job.createdAt = new Date(job.createdAt);
            if (job.updatedAt) job.updatedAt = new Date(job.updatedAt);
            if (job.reminderAt) job.reminderAt = new Date(job.reminderAt);

            if (job.status === 'running') {
                job.status = 'crashed';
                job.crashedAt = new Date();
                job.canRetry = true;
                log('warn', `Tâche ${id} marquée comme crashed (reprise après redémarrage)`);
            }

            jobQueue[id] = job;
        }

        log('info', `${Object.keys(jobQueue).length} tâches restaurées depuis la sauvegarde`);
    } catch (err) {
        if (err.code !== 'ENOENT') {
            log('error', `Erreur lors du chargement de la queue: ${err.message}`);

            try {
                const backupData = await fs.readFile(QUEUE_BACKUP, 'utf-8');
                const backupQueue = JSON.parse(backupData);
                Object.assign(jobQueue, backupQueue);
                log('info', 'Queue restaurée depuis la sauvegarde de secours');
            } catch (backupErr) {
                log('warn', 'Aucune sauvegarde de queue trouvée, démarrage avec une queue vide');
            }
        }
    }
}

let isSaving = false;

let saveLock = null;

async function saveQueue() {
    if (!isDirty) return;

    // Attendre le verrou précédent
    if (saveLock) await saveLock;

    saveLock = (async () => {
        isSaving = true;
        try {
            try {
                await fs.copyFile(QUEUE_FILE, QUEUE_BACKUP);
            } catch (e) {
                // Ignorer si le fichier n'existe pas
            }

            const now = Date.now();
            const filteredQueue = {};

            for (const [id, job] of Object.entries(jobQueue)) {
                const age = now - new Date(job.createdAt).getTime();
                const isRecent = age < 86400000;
                const isActive = ['pending', 'running', 'crashed'].includes(job.status);

                if (isActive || isRecent) {
                    filteredQueue[id] = job;
                }
            }

            await fs.writeFile(
                QUEUE_FILE,
                JSON.stringify(filteredQueue, null, 2)
            );

            isDirty = false;
            log('debug', `Queue sauvegardée (${Object.keys(filteredQueue).length} tâches)`);
        } catch (err) {
            log('error', `Erreur lors de la sauvegarde de la queue: ${err.message}`);
        } finally {
            isSaving = false;
            saveLock = null;
        }
    })();

    return saveLock;
}

function startAutoSave() {
    if (saveTimer) clearInterval(saveTimer);

    saveTimer = setInterval(() => {
        saveQueue();
    }, SAVE_INTERVAL);
}

function stopAutoSave() {
    if (saveTimer) {
        clearInterval(saveTimer);
        saveTimer = null;
    }
}

function log(level, message) {
    const logEntry = { level, message, timestamp: new Date().toISOString() };
    logHistory.push(logEntry);
    if (logHistory.length > MAX_LOGS) {
        logHistory.shift();
    }

    // ✅ N'afficher les logs que si MCP_DEBUG=true
    if (!SILENT_MODE && ['error', 'warn', 'info'].includes(level)) {
        const prefix = {
            error: '[❌ ERROR]',
            warn: '[⚠️  WARN]',
            info: '[ℹ️  INFO]',
            debug: '[🔧 DEBUG]'
        }[level] || `[${level.toUpperCase()}]`;

        // ✅ TOUJOURS utiliser stderr (pas stdout)
        console.error(`${prefix} ${new Date().toISOString().split('T')[1].split('.')[0]} - ${message}`);
    }
}

function addJob(details) {
    if (Object.keys(jobQueue).length >= MAX_QUEUE_SIZE) {
        cleanOldJobs();

        if (Object.keys(jobQueue).length >= MAX_QUEUE_SIZE) {
            throw new Error(`Queue pleine (${MAX_QUEUE_SIZE} tâches max)`);
        }
    }

    const id = uuidv4().split('-')[0];
    const job = {
        id,
        type: details.type || 'unknown',
        ...details,
        createdAt: new Date(),
        retryCount: 0,
        maxRetries: details.maxRetries || 3
    };

    if (details.rappel && details.rappel > 0) {
        job.reminderAt = new Date(Date.now() + details.rappel * 1000);
    }

    jobQueue[id] = job;
    isDirty = true;
    log('info', `Nouvelle tâche ${id} (${job.type}) ajoutée.`);
    return jobQueue[id];
}

function updateJobStatus(id, status, data = {}) {
    if (jobQueue[id]) {
        const oldStatus = jobQueue[id].status;
        jobQueue[id].status = status;
        jobQueue[id].updatedAt = new Date();

        Object.assign(jobQueue[id], data);

        if (data.error) {
            jobQueue[id].error = data.error;
            jobQueue[id].failedAt = new Date();
            log('error', `Tâche ${id} échouée: ${data.error}`);
        } else if (status === 'completed') {
            jobQueue[id].completedAt = new Date();
            const duration = jobQueue[id].completedAt - jobQueue[id].createdAt;
            jobQueue[id].duration = duration;
            log('info', `Tâche ${id} terminée en ${(duration / 1000).toFixed(2)}s`);
        } else {
            log('info', `Tâche ${id}: ${oldStatus} -> ${status}`);
        }

        isDirty = true;
    }
}

function getJob(id) {
    return jobQueue[id];
}

function getQueue() {
    return jobQueue;
}

function getLogs(filter = {}) {
    if (!filter || Object.keys(filter).length === 0) {
        return logHistory;
    }

    return logHistory.filter(log => {
        if (filter.level && log.level !== filter.level) return false;
        if (filter.since && new Date(log.timestamp) < new Date(filter.since)) return false;
        if (filter.search && !log.message.toLowerCase().includes(filter.search.toLowerCase())) return false;
        return true;
    });
}

function cleanOldJobs() {
    const now = Date.now();
    const toDelete = [];
    const MAX_AGE = 86400000;

    for (const [id, job] of Object.entries(jobQueue)) {
        const createdAt = job.createdAt ? new Date(job.createdAt).getTime() : now;
        if (isNaN(createdAt)) {
            log('warn', `Tâche ${id} a une date de création invalide, conservation`);
            continue;
        }

        const age = now - createdAt;

        if (age < 0) {
            log('warn', `Tâche ${id} a une date dans le futur, conservation`);
            continue;
        }

        const isOld = age > MAX_AGE;
        const isCompleted = ['completed', 'failed'].includes(job.status);

        if (isOld && isCompleted) {
            toDelete.push(id);
        }
    }

    for (const id of toDelete) {
        delete jobQueue[id];
    }

    if (toDelete.length > 0) {
        log('info', `${toDelete.length} vieilles tâches supprimées de la queue`);
        isDirty = true;
    }
}

async function retryJob(id) {
    const job = jobQueue[id];
    if (!job) {
        throw new Error(`Tâche ${id} introuvable`);
    }

    if (!['failed', 'crashed'].includes(job.status)) {
        throw new Error(`La tâche ${id} ne peut pas être réessayée (statut: ${job.status})`);
    }

    if (job.retryCount >= job.maxRetries) {
        throw new Error(`La tâche ${id} a atteint le nombre max de tentatives (${job.maxRetries})`);
    }

    const newJob = {
        ...job,
        id: uuidv4().split('-')[0],
        status: 'pending',
        retryCount: (job.retryCount || 0) + 1,
        retriedFrom: id,
        createdAt: new Date(),
        updatedAt: new Date(),
        error: null,
        output: null
    };

    delete newJob.failedAt;
    delete newJob.crashedAt;
    delete newJob.completedAt;

    jobQueue[newJob.id] = newJob;
    isDirty = true;

    log('info', `Tâche ${id} réessayée -> nouvelle tâche ${newJob.id} (tentative ${newJob.retryCount}/${newJob.maxRetries})`);

    return newJob;
}

function getCrashedJobs() {
    return Object.values(jobQueue).filter(job =>
        job.status === 'crashed' &&
        job.canRetry &&
        job.retryCount < job.maxRetries
    );
}

function getStats() {
    const stats = {
        total: Object.keys(jobQueue).length,
        byStatus: {},
        byType: {},
        avgDuration: 0,
        successRate: 0
    };

    let totalDuration = 0;
    let completedCount = 0;

    for (const job of Object.values(jobQueue)) {
        stats.byStatus[job.status] = (stats.byStatus[job.status] || 0) + 1;
        stats.byType[job.type] = (stats.byType[job.type] || 0) + 1;

        if (job.duration) {
            totalDuration += job.duration;
            completedCount++;
        }
    }

    if (completedCount > 0) {
        stats.avgDuration = Math.round(totalDuration / completedCount);
    }

    const totalFinished = (stats.byStatus.completed || 0) + (stats.byStatus.failed || 0);
    if (totalFinished > 0) {
        stats.successRate = Math.round((stats.byStatus.completed || 0) / totalFinished * 100);
    }

    return stats;
}

async function init() {
    await loadQueue();
    startAutoSave();
    setInterval(cleanOldJobs, 3600000);
}

async function shutdown() {
    log('info', 'Arrêt du gestionnaire de queue...');
    stopAutoSave();
    await saveQueue();
}

process.on('SIGINT', async () => {
    await shutdown();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await shutdown();
    process.exit(0);
});


export default {
    addJob,
    updateJobStatus,
    getJob,
    getQueue,
    getLogs,
    log,
    retryJob,
    getCrashedJobs,
    getStats,
    cleanOldJobs,
    saveQueue,
    shutdown,
    init
};
