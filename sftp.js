import SftpClient from 'ssh2-sftp-client';
import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import queue from './queue.js';
import serverManager from './servers.js';
import sourceAdapter from './sourceAdapter.js';
import fileOps from './fileOps.js';
import micromatch from 'micromatch';
import utils from './utils.js';

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
        sourceAdapter.assertLocalPathAllowed(fullPattern);
        const files = await glob(fullPattern, { nodir: false });
        for (const f of files) sourceAdapter.assertLocalPathAllowed(f);
        return files;
    }

    // Sinon c'est un fichier/dossier simple
    const fullPath = path.resolve(normalizedBasePath, pattern);
    sourceAdapter.assertLocalPathAllowed(fullPath);
    return [fullPath];
}

/**
 * Copie une entrée remote -> remote via le pool SFTP partagé.
 *
 * - fichier : respecte force:false et append le basename si la cible est un dossier ;
 * - dossier : copie récursivement les fichiers sous la racine cible ; force:false
 *   refuse une cible déjà existante afin d'éviter les merges/écrasements implicites.
 *
 * Note : les symlinks inclus dans un arbre sont volontairement ignorés par
 * listFilesRecursive pour l'instant. La future stratégie direct/rsync devra les
 * préserver ; le résultat expose un warning pour ne pas promettre une copie bit-à-bit.
 */
async function transferServerToServerEntry(file, job, force) {
    const srcAlias = file.source_alias || job.source_alias;
    const srcPath = file.source_path || file.local || file.remote;
    const tgtAlias = job.alias;
    const tgtPath = file.remote;

    if (!srcAlias) throw new Error("source_alias requis pour server_to_server.");
    if (!srcPath) throw new Error("Chemin source requis (local/source_path) pour server_to_server.");
    if (!tgtPath) throw new Error("Chemin destination remote requis pour server_to_server.");

    const srcKind = await sourceAdapter.exists({ type: 'remote', alias: srcAlias, path: srcPath });
    if (!srcKind) throw new Error(`Source introuvable: ${srcAlias}:${srcPath}`);

    if (srcKind === 'd') {
        const dstKind = await sourceAdapter.exists({ type: 'remote', alias: tgtAlias, path: tgtPath });
        if (dstKind && dstKind !== 'd') {
            throw new Error(`La destination ${tgtAlias}:${tgtPath} existe et n'est pas un dossier.`);
        }
        if (dstKind && !force) {
            throw new Error(
                `Le dossier destination ${tgtAlias}:${tgtPath} existe déjà. ` +
                `Utilisez force:true pour fusionner/écraser explicitement.`
            );
        }

        const rels = await sourceAdapter.listFilesRecursive(
            { type: 'remote', alias: srcAlias, path: srcPath },
            { recursive: true, ignorePatterns: [] }
        );
        let success = 0;
        const failures = [];
        for (const rel of rels) {
            const from = path.posix.join(srcPath, rel);
            const to = path.posix.join(tgtPath, rel);
            try {
                const buf = await sourceAdapter.readFile({ type: 'remote', alias: srcAlias, path: from });
                await sourceAdapter.writeFile({ type: 'remote', alias: tgtAlias, path: to }, buf.content, { createDirs: true });
                success++;
            } catch (e) {
                failures.push({ file: from, target: to, error: e.message });
            }
        }
        return {
            total: rels.length, success, failures,
            warning: 'Copie dossier SFTP: symlinks et dossiers vides non préservés; utiliser une future stratégie rsync/tar pour une réplication bit-à-bit.'
        };
    }

    let finalTarget = tgtPath;
    const dstKind = await sourceAdapter.exists({ type: 'remote', alias: tgtAlias, path: tgtPath });
    if (dstKind === 'd') {
        finalTarget = path.posix.join(tgtPath, path.posix.basename(srcPath));
        const nestedKind = await sourceAdapter.exists({ type: 'remote', alias: tgtAlias, path: finalTarget });
        if (nestedKind && !force) {
            throw new Error(`Le fichier distant ${tgtAlias}:${finalTarget} existe déjà. Utilisez force:true.`);
        }
    } else if (dstKind && !force) {
        throw new Error(`Le fichier distant ${tgtAlias}:${tgtPath} existe déjà. Utilisez force:true.`);
    }

    const buf = await sourceAdapter.readFile({ type: 'remote', alias: srcAlias, path: srcPath });
    await sourceAdapter.writeFile({ type: 'remote', alias: tgtAlias, path: finalTarget }, buf.content, { createDirs: true });
    return { total: 1, success: 1, failures: [] };
}

// Fonction principale de transfert avec support multi-fichiers
async function executeTransfer(jobId) {
    const job = queue.getJob(jobId);
    if (!job) return queue.log('error', `Tâche introuvable: ${jobId}`);

    let sftp = null;
    try {
        queue.updateJobStatus(jobId, 'running');

        // Déterminer si on traite plusieurs fichiers
        const files = job.files || [{ local: job.local, remote: job.remote }];
        const isMultiple = Array.isArray(job.files) && job.files.length > 1;
        const force = job.force === true;

        let successCount = 0;
        let failedFiles = [];
        let totalFiles = 0;

        // server_to_server : 100% pool via sourceAdapter (fichiers + dossiers)
        if (job.direction === 'server_to_server') {
            const warnings = [];
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const progress = isMultiple ? ` (${i + 1}/${files.length})` : '';
                const srcAlias = file.source_alias || job.source_alias;
                const srcPath = file.source_path || file.local || file.remote;
                try {
                    queue.log('info', `Transfert server_to_server${progress}: ${srcAlias}:${srcPath} → ${job.alias}:${file.remote}`);
                    const result = await transferServerToServerEntry(file, job, force);
                    totalFiles += result.total;
                    successCount += result.success;
                    if (result.failures?.length) failedFiles.push(...result.failures);
                    if (result.warning && !warnings.includes(result.warning)) warnings.push(result.warning);
                } catch (err) {
                    totalFiles += 1; // l'item lui-même a été tenté, même si son contenu n'a pas pu être énuméré
                    queue.log('error', `Échec transfert ${srcPath || file.remote}: ${err.message}`);
                    failedFiles.push({ file: srcPath || file.remote, error: err.message });
                }
            }
            job.transferWarnings = warnings;
        } else {
            // upload/download : SftpClient (dirs/glob) avec port configurable
            const serverConfig = await serverManager.getServer(job.alias);
            sftp = new SftpClient();
            const sftpConfig = {
                host: serverConfig.host,
                port: utils.resolveSshPort(serverConfig),
                username: serverConfig.user,
                readyTimeout: 20000,
                retries: 3,
                retry_factor: 2,
                retry_minTimeout: 2000
            };
            if (serverConfig.keyPath) {
                sftpConfig.privateKey = await fs.readFile(serverConfig.keyPath);
            } else if (serverConfig.password) {
                sftpConfig.password = serverConfig.password;
            } else {
                throw new Error(`Aucune méthode d'authentification pour '${job.alias}'.`);
            }
            await sftp.connect(sftpConfig);

            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const progress = isMultiple ? ` (${i + 1}/${files.length})` : '';

                try {
                    if (job.direction === 'upload') {
                        const localFiles = await expandFileList(file.local);
                        totalFiles += localFiles.length;
                        for (const localFile of localFiles) {
                            queue.log('info', `Transfert${progress}: ${localFile}`);
                            // Fichier simple (pas dir) → pool sourceAdapter quand possible
                            let isDir = false;
                            try {
                                const st = await fs.stat(localFile);
                                isDir = st.isDirectory();
                            } catch { /* handled in handleUpload */ }
                            if (!isDir && !hasGlobPattern(file.remote || '')) {
                                const content = await fs.readFile(localFile);
                                let remotePath = file.remote;
                                // Si remote est un dossier existant, append basename — handleUpload fait ça ;
                                // pour pool on délègue à handleUpload si exists dir, sinon writeFile
                                await handleUpload(sftp, localFile, file.remote, force);
                            } else {
                                await handleUpload(sftp, localFile, file.remote, force);
                            }
                            successCount++;
                        }
                    } else if (job.direction === 'download') {
                        const downloadedCount = await handleDownload(sftp, file.remote, file.local, force);
                        totalFiles += downloadedCount;
                        successCount += downloadedCount;
                    }
                } catch (err) {
                    queue.log('error', `Échec transfert ${file.local || file.remote}: ${err.message}`);
                    failedFiles.push({ file: file.local || file.remote, error: err.message });
                }
            }
        }
        
        // Génération du rapport (end() uniquement dans finally pour éviter double close)
        let status = successCount === totalFiles ? 'completed' : 'partial';
        let output = `Transfert ${job.direction}: ${successCount}/${totalFiles} fichiers réussis`;
        
        if (failedFiles.length > 0) {
            output += `\nÉchecs: ${failedFiles.map(f => f.file).join(', ')}`;
            if (successCount === 0) status = 'failed';
        }
        
        if (job.transferWarnings?.length) {
            output += `\nAvertissements: ${job.transferWarnings.join(' | ')}`;
        }
        queue.updateJobStatus(jobId, status, { output, failedFiles, warnings: job.transferWarnings || [] });
        
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
    sourceAdapter.assertLocalPathAllowed(localPath);
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
    sourceAdapter.assertLocalPathAllowed(localPath);
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
                const remoteFile = path.posix.join(parentDir, fileName);
                const localFile = path.join(localPath, fileName);
                sourceAdapter.assertLocalPathAllowed(localFile);

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

        sourceAdapter.assertLocalPathAllowed(finalLocalPath);
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