import SftpClient from 'ssh2-sftp-client';
import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import queue from './queue.js';
import serverManager from './servers.js';
import sourceAdapter from './sourceAdapter.js';
import fileOps from './fileOps.js';
import micromatch from 'micromatch';

// Fonction utilitaire pour créer un dossier parent si nécessaire
async function ensureLocalDir(filePath) {
    const dir = path.dirname(filePath);
    try {
        await fs.access(dir);
    } catch {
        await fs.mkdir(dir, { recursive: true });
        queue.log('info', `Dossier local créé: ${dir}`);
    }
}

function hasGlobPattern(str) {
    return /[*?[\]]/.test(str);
}

// Fonction pour créer un dossier distant si nécessaire
async function ensureRemoteDir(sftp, filePath) {
    const dir = path.posix.dirname(filePath); // Utiliser posix pour les chemins distants
    
    if (dir === '/' || dir === '.') {
        return; // Pas besoin de créer la racine
    }
    
    try {
        const exists = await sftp.exists(dir);
        if (!exists) {
            await sftp.mkdir(dir, true); // true pour créer récursivement
            queue.log('info', `Dossier distant créé: ${dir}`);
        }
    } catch (err) {
        // Vérifier si c'est vraiment une erreur ou si le dossier existe déjà
        const exists = await sftp.exists(dir).catch(() => false);
        if (!exists) {
            throw new Error(`Impossible de créer le dossier distant ${dir}: ${err.message}`);
        }
        // Sinon, le dossier existe, on continue
    }
}

// Fonction pour gérer les patterns glob et listes de fichiers
async function expandFileList(pattern, basePath = '') {
    // Si c'est une liste (tableau)
    if (Array.isArray(pattern)) {
        const allFiles = [];
        for (const p of pattern) {
            const expanded = await expandFileList(p, basePath);
            allFiles.push(...expanded);
        }
        return allFiles;
    }

    // Fonction interne pour normaliser les chemins
    function normalizePath(filePath, bPath) {
        if (path.isAbsolute(filePath)) {
            return filePath;
        }
        return path.resolve(bPath || process.cwd(), filePath);
    }

    const normalizedBasePath = normalizePath(basePath);

    // Si c'est un pattern glob
    if (pattern.includes('*') || pattern.includes('?') || pattern.includes('[')) {
        const fullPattern = path.resolve(normalizedBasePath, pattern);
        const files = await glob(fullPattern, { nodir: false });
        return files;
    }

    // Sinon c'est un fichier/dossier simple
    const fullPath = path.resolve(normalizedBasePath, pattern);
    return [fullPath];
}

// Fonction principale de transfert avec support multi-fichiers
async function executeTransfer(jobId) {
    const job = queue.getJob(jobId);
    if (!job) return queue.log('error', `Tâche introuvable: ${jobId}`);

    let sftp = null;
    try {
        const serverConfig = await serverManager.getServer(job.alias);
        queue.updateJobStatus(jobId, 'running');

        sftp = new SftpClient();

        // Configuration de la connexion
        const config = {
            host: serverConfig.host,
            port: 22,
            username: serverConfig.user,
            readyTimeout: 20000,
            retries: 3,
            retry_factor: 2,
            retry_minTimeout: 2000
        };
        
        if (serverConfig.keyPath) {
            config.privateKey = await fs.readFile(serverConfig.keyPath);
        } else if (serverConfig.password) {
            config.password = serverConfig.password;
        } else {
            throw new Error(`Aucune méthode d'authentification pour '${job.alias}'.`);
        }

        await sftp.connect(config);
        
        // Déterminer si on traite plusieurs fichiers
        const files = job.files || [{ local: job.local, remote: job.remote }];
        const isMultiple = Array.isArray(job.files) && job.files.length > 1;
        const force = job.force === true;

        let successCount = 0;
        let failedFiles = [];
        let totalFiles = 0;

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const progress = isMultiple ? ` (${i + 1}/${files.length})` : '';

            try {
                if (job.direction === 'upload') {
                    const localFiles = await expandFileList(file.local);
                    totalFiles += localFiles.length;
                    for (const localFile of localFiles) {
                        queue.log('info', `Transfert${progress}: ${localFile}`);
                        await handleUpload(sftp, localFile, file.remote, force);
                        successCount++;
                    }
                } else if (job.direction === 'download') {
                    const downloadedCount = await handleDownload(sftp, file.remote, file.local, force);
                    totalFiles += downloadedCount;
                    successCount += downloadedCount;
                } else if (job.direction === 'server_to_server') {
                    // Transfert direct entre deux serveurs distants (ou local↔remote inversé)
                    const srcAlias = file.source_alias || job.source_alias;
                    const srcPath = file.source_path || file.local || file.remote;
                    const tgtAlias = job.alias;
                    const tgtPath = file.remote;

                    queue.log('info', `Transfert server_to_server${progress}: ${srcAlias}:${srcPath} → ${tgtAlias}:${tgtPath}`);
                    const buf = await sourceAdapter.readFile({ type: 'remote', alias: srcAlias, path: srcPath });
                    await sourceAdapter.writeFile({ type: 'remote', alias: tgtAlias, path: tgtPath }, buf.content, { createDirs: true });
                    successCount++;
                    totalFiles++;
                }
            } catch (err) {
                queue.log('error', `Échec transfert ${file.local || file.remote}: ${err.message}`);
                failedFiles.push({ file: file.local || file.remote, error: err.message });
            }
        }
        
        await sftp.end();
        
        // Génération du rapport
        let status = successCount === totalFiles ? 'completed' : 'partial';
        let output = `Transfert ${job.direction}: ${successCount}/${totalFiles} fichiers réussis`;
        
        if (failedFiles.length > 0) {
            output += `\nÉchecs: ${failedFiles.map(f => f.file).join(', ')}`;
            if (successCount === 0) status = 'failed';
        }
        
        queue.updateJobStatus(jobId, status, { output, failedFiles });
        
    } catch (err) {
        queue.updateJobStatus(jobId, 'failed', { error: err.message });
    } finally {
        if (sftp) {
            try {
                await sftp.end();
            } catch (e) {
                // Ignorer les erreurs de fermeture
            }
        }
    }
}

// Gestion spécifique de l'upload
async function handleUpload(sftp, localPath, remotePath, force = false) {
    let localStats;
    try {
        localStats = await fs.stat(localPath);
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new Error(`Fichier local introuvable: ${localPath}`);
        }
        throw err;
    }

    if (localStats.isDirectory()) {
        const remoteExists = await sftp.exists(remotePath).catch(() => false);
        if (remoteExists) {
            try {
                const remoteStats = await sftp.stat(remotePath);
                if (!remoteStats.isDirectory) {
                    throw new Error(`Impossible d'envoyer un dossier local vers un fichier distant existant: ${remotePath}. Spécifiez un dossier de destination.`);
                }
            } catch (e) {
                if (e.message && e.message.includes('Impossible d')) throw e;
            }
        }
        await sftp.uploadDir(localPath, remotePath);
        return;
    }

    let finalRemotePath;
    const remoteExists = await sftp.exists(remotePath).catch(() => false);

    if (remoteExists) {
        let remoteStats;
        try {
            remoteStats = await sftp.stat(remotePath);
        } catch (e) {
            remoteStats = null;
        }

        if (remoteStats && remoteStats.isDirectory) {
            finalRemotePath = path.posix.join(remotePath, path.basename(localPath));
        } else {
            if (!force) {
                throw new Error(`Le fichier distant ${remotePath} existe déjà. Utilisez force:true pour l'écraser.`);
            }
            finalRemotePath = remotePath;
        }
    } else {
        finalRemotePath = remotePath;
    }

    await ensureRemoteDir(sftp, finalRemotePath);
    await sftp.put(localPath, finalRemotePath);
}

// Gestion spécifique du download
async function handleDownload(sftp, remotePath, localPath, force = false) {
    if (hasGlobPattern(remotePath)) {
        const parentDir = path.dirname(remotePath);
        const pattern = path.basename(remotePath);

        try {
            const fileList = await sftp.list(parentDir);
            const matchingFiles = micromatch(fileList.map(f => f.name), [pattern]);

            if (matchingFiles.length === 0) {
                throw new Error(`Aucun fichier distant ne correspond au pattern: ${remotePath}`);
            }

            await fs.mkdir(localPath, { recursive: true });

            for (const fileName of matchingFiles) {
                const remoteFile = path.join(parentDir, fileName);
                const localFile = path.join(localPath, fileName);

                const localFileExists = await fs.access(localFile).then(() => true).catch(() => false);
                if (localFileExists && !force) {
                    throw new Error(`Le fichier local ${localFile} existe déjà. Utilisez force:true pour l'écraser.`);
                }

                queue.log('info', `Téléchargement (glob): ${remoteFile} -> ${localFile}`);
                await sftp.get(remoteFile, localFile);
            }
            return matchingFiles.length;
        } catch (err) {
            if (err.code === 2) {
                 throw new Error(`Le dossier parent pour le glob n'existe pas: ${parentDir}`);
            }
            throw err;
        }

    } else {
        const remoteExists = await sftp.exists(remotePath);
        if (!remoteExists) {
            throw new Error(`Fichier distant introuvable: ${remotePath}`);
        }

        const remoteStats = await sftp.stat(remotePath);

        if (remoteStats.isDirectory) {
            await fs.mkdir(localPath, { recursive: true });
            await sftp.downloadDir(remotePath, localPath);
            return 1;
        }

        let finalLocalPath;
        const localExists = await fs.access(localPath).then(() => true).catch(() => false);

        if (localExists) {
            let localStats;
            try {
                localStats = await fs.stat(localPath);
            } catch (e) {
                localStats = null;
            }

            if (localStats && localStats.isDirectory()) {
                finalLocalPath = path.join(localPath, path.basename(remotePath));
            } else {
                if (!force) {
                    throw new Error(`Le fichier local ${localPath} existe déjà. Utilisez force:true pour l'écraser.`);
                }
                finalLocalPath = localPath;
            }
        } else {
            const hasExt = path.extname(localPath) !== '';
            if (hasExt) {
                finalLocalPath = localPath;
            } else {
                await fs.mkdir(localPath, { recursive: true });
                finalLocalPath = path.join(localPath, path.basename(remotePath));
            }
        }

        const localDir = path.dirname(finalLocalPath);
        await fs.mkdir(localDir, { recursive: true });
        await sftp.get(remotePath, finalLocalPath);
        return 1;
    }
}

// Nouvelle fonction pour les transferts multiples
async function executeMultiTransfer(jobId) {
    const job = queue.getJob(jobId);
    if (!job) return queue.log('error', `Tâche introuvable: ${jobId}`);
    
    // Utilise la même fonction mais avec support multi-fichiers
    return executeTransfer(jobId);
}

export default { executeTransfer, executeMultiTransfer };