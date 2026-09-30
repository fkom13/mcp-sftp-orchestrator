import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import config from './config.js';

const QUEUE_FILE = path.join(config.dataDir, 'queue.json');
const QUEUE_BACKUP = path.join(config.dataDir, 'queue.backup.json');
const SAVE_INTERVAL = config.saveInterval || 5000;
const MAX_ACTIVE_JOBS = config.maxActiveJobs || config.maxQueueSize || 1000;
const MAX_TERMINAL_HISTORY = config.maxTaskHistory || 300;
const TERMINAL_RETENTION = config.historyRetention || 2678400000;
const ACTIVE_STATUSES = new Set(['pending', 'running']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'crashed', 'partial']);

// ✅ Mode silencieux par défaut (logs désactivés sauf si MCP_DEBUG=true)
const SILENT_MODE = process.env.MCP_DEBUG !== 'true';

const jobQueue = {};
const logHistory = [];
const MAX_LOGS = 500;

let saveTimer = null;
let isDirty = false;
let dirtyRevision = 0;

function markDirty() {
    isDirty = true;
    dirtyRevision++;
}

function getJobTimestamp(job) {
    const raw = job.updatedAt || job.completedAt || job.failedAt || job.crashedAt || job.createdAt;
    const ts = raw ? new Date(raw).getTime() : 0;
    return Number.isFinite(ts) ? ts : 0;
}

function getActiveCount() {
    return Object.values(jobQueue).filter(job => ACTIVE_STATUSES.has(job.status)).length;
}

function assertActiveCapacity() {
    const activeCount = getActiveCount();
    if (activeCount >= MAX_ACTIVE_JOBS) {
        throw new Error(`Queue active pleine (${MAX_ACTIVE_JOBS} tâches max)`);
    }
}

function rotateTerminalHistory() {
    const now = Date.now();
    const terminalJobs = Object.entries(jobQueue)
        .filter(([, job]) => TERMINAL_STATUSES.has(job.status))
        .sort((a, b) => getJobTimestamp(b[1]) - getJobTimestamp(a[1]));

    const keepIds = new Set(
        terminalJobs
            .filter(([, job]) => {
                const ts = getJobTimestamp(job);
                return !TERMINAL_RETENTION || !ts || now - ts <= TERMINAL_RETENTION;
            })
            .slice(0, MAX_TERMINAL_HISTORY)
            .map(([id]) => id)
    );

    const toDelete = terminalJobs
        .map(([id]) => id)
        .filter(id => !keepIds.has(id));

    for (const id of toDelete) delete jobQueue[id];

    if (toDelete.length > 0) {
        markDirty();
        log('info', `${toDelete.length} tâche(s) terminale(s) retirée(s) par rotation d'historique`);
    }

    return toDelete.length;
}

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

        rotateTerminalHistory();
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

    // Attendre le save précédent puis revalider : il a peut-être déjà persisté
    // toutes les mutations connues au moment de cet appel.
    if (saveLock) {
        await saveLock;
        if (!isDirty) return;
    }

    saveLock = (async () => {
        isSaving = true;
        let tmpPath = null;
        rotateTerminalHistory();
        const revisionAtStart = dirtyRevision;
        try {
            try {
                await fs.copyFile(QUEUE_FILE, QUEUE_BACKUP);
            } catch (e) {
                // Ignorer si le fichier n'existe pas
            }

            const filteredQueue = { ...jobQueue };

            // Écriture atomique : un crash ne peut plus laisser queue.json tronqué.
            tmpPath = `${QUEUE_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
            await fs.writeFile(tmpPath, JSON.stringify(filteredQueue, null, 2));
            await fs.rename(tmpPath, QUEUE_FILE);
            tmpPath = null;

            // Une mutation a pu arriver pendant les awaits ci-dessus. Ne jamais
            // effacer son dirty flag : le prochain tick la persistera.
            isDirty = dirtyRevision !== revisionAtStart;
            log('debug', `Queue sauvegardée (${Object.keys(filteredQueue).length} tâches, dirty=${isDirty})`);
        } catch (err) {
            isDirty = true;
            if (tmpPath) await fs.rm(tmpPath, { force: true }).catch(() => {});
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
    rotateTerminalHistory();
    assertActiveCapacity();

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
    markDirty();
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

        markDirty();
        if (TERMINAL_STATUSES.has(status)) {
            rotateTerminalHistory();
        }
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
    return rotateTerminalHistory();
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

    rotateTerminalHistory();
    assertActiveCapacity();

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
    markDirty();

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

function getRetryableJobs(statusFilter = null) {
    return Object.values(jobQueue).filter(job => {
        if (!['failed', 'crashed'].includes(job.status)) return false;
        if (statusFilter && job.status !== statusFilter) return false;
        if ((job.retryCount || 0) >= (job.maxRetries || 3)) return false;
        return true;
    });
}

/**
 * Purge des jobs terminés/crashés.
 * options = { status?: 'crashed'|'failed'|'completed'|'all_terminal', olderThanDays?: number, dryRun?: bool }
 */
function purgeJobs(options = {}) {
    const olderThanDays = options.olderThanDays ?? 0;
    const dryRun = options.dryRun === true;
    const status = options.status || 'crashed';
    const now = Date.now();
    const maxAge = olderThanDays > 0 ? olderThanDays * 86400000 : 0;

    const terminal = TERMINAL_STATUSES;
    const toDelete = [];

    for (const [id, job] of Object.entries(jobQueue)) {
        let match = false;
        if (status === 'all_terminal') {
            match = terminal.has(job.status);
        } else {
            match = job.status === status;
        }
        if (!match) continue;

        if (maxAge > 0) {
            const created = job.createdAt ? new Date(job.createdAt).getTime() : now;
            if (now - created < maxAge) continue;
        }
        toDelete.push(id);
    }

    if (!dryRun) {
        for (const id of toDelete) delete jobQueue[id];
        if (toDelete.length) {
            markDirty();
            log('info', `Purge: ${toDelete.length} tâche(s) supprimée(s) (status=${status})`);
        }
    }

    return { purged: toDelete.length, ids: toDelete, dryRun };
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

export default {
    addJob,
    updateJobStatus,
    getJob,
    getQueue,
    getLogs,
    log,
    retryJob,
    getCrashedJobs,
    getRetryableJobs,
    purgeJobs,
    getStats,
    getActiveCount,
    cleanOldJobs,
    rotateTerminalHistory,
    saveQueue,
    shutdown,
    init
};
