import SftpClient from 'ssh2-sftp-client';
import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import queue from './queue.js';
import serverManager from './servers.js';
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

// Fonction pour créer un dossier distant si nécessaire
async function ensureRemoteDir(sftp, filePath) {
    const dir = path.dirname(filePath);
    try {
        const exists = await sftp.exists(dir);
        if (!exists) {
            await sftp.mkdir(dir, true);
            queue.log('info', `Dossier distant créé: ${dir}`);
        }
    } catch (err) {
        // Si le dossier existe déjà, on ignore l'erreur
        if (!err.message.includes('already exists')) {
            throw err;
        }
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
        const fullPattern = path.join(normalizedBasePath, pattern);
        const files = await glob(fullPattern, { nodir: false });
        return files;
    }

    // Sinon c'est un fichier/dossier simple
    const fullPath = path.join(normalizedBasePath, pattern);
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
        
        let successCount = 0;
        let failedFiles = [];
        let totalFiles = 0;
        
        // Traiter chaque fichier
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const progress = isMultiple ? ` (${i + 1}/${files.length})` : '';
            
            try {
                if (job.direction === 'upload') {
                    const localFiles = await expandFileList(file.local);
                    totalFiles += localFiles.length;
                    for (const localFile of localFiles) {
                        queue.log('info', `Transfert${progress}: ${localFile}`);
                        await handleUpload(sftp, localFile, file.remote);
                        successCount++;
                    }
                } else if (job.direction === 'download') {
                    const downloadedCount = await handleDownload(sftp, file.remote, file.local);
                    totalFiles += downloadedCount;
                    successCount += downloadedCount;
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
async function handleUpload(sftp, localPath, remotePath) {
    try {
        const stats = await fs.stat(localPath);
        
        if (stats.isDirectory()) {
            // Upload d'un dossier entier
            await sftp.uploadDir(localPath, remotePath);
        } else {
            // Upload d'un fichier - créer le dossier parent si nécessaire
            await ensureRemoteDir(sftp, remotePath);
            await sftp.put(localPath, remotePath);
        }
    } catch (err) {
        // Si le fichier local n'existe pas
        if (err.code === 'ENOENT') {
            throw new Error(`Fichier local introuvable: ${localPath}`);
        }
        throw err;
    }
}

// Gestion spécifique du download
async function handleDownload(sftp, remotePath, localPath) {
    // Si le chemin distant contient un glob
    if (micromatch.isMatch(remotePath, '**/*')) {
        const parentDir = path.dirname(remotePath);
        const pattern = path.basename(remotePath);

        try {
            const fileList = await sftp.list(parentDir);
            const matchingFiles = micromatch(fileList.map(f => f.name), [pattern]);

            if (matchingFiles.length === 0) {
                throw new Error(`Aucun fichier distant ne correspond au pattern: ${remotePath}`);
            }

            // S'assurer que le dossier local existe
            await ensureLocalDir(localPath);

            // Télécharger chaque fichier correspondant
            for (const fileName of matchingFiles) {
                const remoteFile = path.join(parentDir, fileName);
                const localFile = path.join(localPath, fileName);
                queue.log('info', `Téléchargement (glob): ${remoteFile} -> ${localFile}`);
                await sftp.get(remoteFile, localFile);
            }
            // Retourner le nombre de fichiers téléchargés pour le rapport
            return matchingFiles.length;
        } catch (err) {
            // Si le dossier parent n'existe pas, on propage l'erreur
            if (err.code === 2) {
                 throw new Error(`Le dossier parent pour le glob n'existe pas: ${parentDir}`);
            }
            throw err;
        }

    } else {
        // Comportement normal pour un fichier ou un dossier unique
        const exists = await sftp.exists(remotePath);
        if (!exists) {
            throw new Error(`Fichier distant introuvable: ${remotePath}`);
        }

        const stats = await sftp.stat(remotePath);
        await ensureLocalDir(localPath);

        if (stats.isDirectory) {
            await sftp.downloadDir(remotePath, localPath);
        } else {
            await sftp.get(remotePath, localPath);
        }
        return 1; // Un seul item téléchargé
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
