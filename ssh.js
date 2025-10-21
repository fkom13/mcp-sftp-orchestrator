import { Client } from 'ssh2';
import fs from 'fs/promises';
import queue from './queue.js';
import serverManager from './servers.js';
import sshPool from './sshPool.js';
import config from './config.js';

const STREAMING_COMMANDS = [
    /^pm2\s+logs?\b/i,
    /^docker\s+logs?\s+(-f|--follow)/i,
    /^tail\s+-f/i,
    /^journalctl\s+-f/i,
    /^watch\b/i,
    /^top\b/i,
    /^htop\b/i,
    /^less\b/i,
    /^more\b/i,
    /^vim?\b/i,
    /^nano\b/i
];

function isStreamingCommand(cmd) {
    return STREAMING_COMMANDS.some(pattern => pattern.test(cmd.trim()));
}

// Configuration des réponses automatiques pour les prompts interactifs
const INTERACTIVE_RESPONSES = {
    // Patterns courants et leurs réponses
    'continue connecting': 'yes',
    'Are you sure': 'yes',
    'password:': null, // Sera géré séparément
    'Password:': null,
    'Do you want to continue': 'y',
    'Overwrite': 'y',
    'Save': 'y'
};

// Détecte si une sortie contient un prompt interactif
function detectInteractivePrompt(output) {
    const lastLine = output.split('\n').pop().toLowerCase();
    
    for (const [pattern, response] of Object.entries(INTERACTIVE_RESPONSES)) {
        if (lastLine.includes(pattern.toLowerCase())) {
            return { pattern, response, needsInput: true };
        }
    }
    
    // Vérifier les patterns qui attendent une entrée
    if (lastLine.endsWith(':') || lastLine.endsWith('?') || 
        lastLine.includes('[y/n]') || lastLine.includes('(yes/no)')) {
        return { pattern: 'generic', response: null, needsInput: true };
    }
    
    return { needsInput: false };
}

// Exécution de commande avec pool de connexions
async function executeCommand(jobId) {
    const job = queue.getJob(jobId);
    if (!job) return queue.log('error', `Tâche introuvable: ${jobId}`);

    let connection = null;
    
    try {
        const serverConfig = await serverManager.getServer(job.alias);
        queue.updateJobStatus(jobId, 'running');

        // Utiliser le pool de connexions si pas de mode interactif
        const usePool = !job.interactive && job.persistent !== false;
        
        if (usePool) {
            // Obtenir une connexion du pool
            connection = await sshPool.getConnection(job.alias, serverConfig);
            await executeWithPooledConnection(connection, job, jobId);
        } else {
            // Créer une connexion dédiée pour les commandes interactives
            await executeWithNewConnection(serverConfig, job, jobId);
        }
        
    } catch (err) {
        queue.updateJobStatus(jobId, 'failed', { error: err.message });
    } finally {
        // Libérer la connexion si elle vient du pool
        if (connection) {
            sshPool.releaseConnection(connection.id);
        }
    }
}

// Exécution avec une connexion du pool
async function executeWithPooledConnection(connection, job, jobId) {
    return new Promise((resolve, reject) => {
        const { client } = connection;

        const isStreaming = job.streaming || isStreamingCommand(job.cmd);
        let cmdToExecute = job.cmd;

        if (isStreaming) {
            const maxLines = job.maxLines || 100;
            const streamTimeout = job.streamTimeout || 10;
            if (/^pm2\s+logs?\b/i.test(cmdToExecute)) {
                cmdToExecute = cmdToExecute.replace(/\s+--lines\s+\d+/gi, '').replace(/\s+--nostream/gi, '');
                cmdToExecute += ` --lines ${maxLines} --nostream`;
            } else if (/^docker\s+logs?\b/i.test(cmdToExecute)) {
                cmdToExecute = cmdToExecute.replace(/\s+-f\b|--follow\b/gi, '').replace(/\s+--tail\s+\d+/gi, '');
                cmdToExecute += ` --tail ${maxLines}`;
            } else if (/^tail\s+-f/i.test(cmdToExecute)) {
                cmdToExecute = `timeout ${streamTimeout} ` + cmdToExecute.replace(/-f\b/gi, '') + ` | head -n ${maxLines}`;
            } else if (/^journalctl\s+-f/i.test(cmdToExecute)) {
                cmdToExecute = cmdToExecute.replace(/-f\b/gi, '') + ` -n ${maxLines}`;
            } else {
                cmdToExecute = `timeout ${streamTimeout} ${cmdToExecute}`;
            }
            queue.log('info', `Commande streaming transformée: ${cmdToExecute}`);
        }

        client.exec(cmdToExecute, { pty: job.pty }, (err, stream) => {
            if (err) {
                reject(err);
                return;
            }
            
            let output = '';
            let stderr = '';
            let lineCount = 0;
            const startTime = Date.now();
            const maxLines = job.maxLines || 1000;
            const timeout = job.timeout || config.defaultCommandTimeout;
            
            const timeoutId = setTimeout(() => {
                stream.write('\x03'); // Envoyer Ctrl+C
                setTimeout(() => {
                    stream.close();
                    const duration = Date.now() - startTime;
                    const result = { output: output.trim(), stderr: stderr.trim(), exitCode: 124, duration, lineCount, timedOut: true };
                    queue.updateJobStatus(jobId, 'completed', result);
                    resolve(result);
                }, 500);
            }, timeout);
            
            stream.on('close', (code, signal) => {
                clearTimeout(timeoutId);
                const duration = Date.now() - startTime;
                const result = { output: output.trim(), stderr: stderr.trim(), exitCode: code, signal, duration, lineCount };
                if (code === 0 || code === 124) {
                    queue.updateJobStatus(jobId, 'completed', result);
                    resolve(result);
                } else {
                    queue.updateJobStatus(jobId, 'failed', { ...result, error: `Commande terminée avec code ${code}` });
                    reject(new Error(`Exit code: ${code}`));
                }
            });
            
            stream.on('data', (data) => {
                const chunk = data.toString();
                output += chunk;
                lineCount += (chunk.match(/\n/g) || []).length;
                if (isStreaming && lineCount >= maxLines) {
                    stream.write('\x03');
                    setTimeout(() => stream.close(), 500);
                }
                if (job.autoRespond) {
                    const prompt = detectInteractivePrompt(output);
                    if (prompt.needsInput && prompt.response) {
                        stream.write(prompt.response + '\n');
                        queue.log('info', `Réponse automatique au prompt: ${prompt.pattern}`);
                    }
                }
            });
            
            stream.stderr.on('data', (data) => {
                stderr += data.toString();
            });
        });
    });
}

// Exécution avec une nouvelle connexion (pour commandes interactives)
async function executeWithNewConnection(serverConfig, job, jobId) {
    return new Promise((resolve, reject) => {
        const conn = new Client();

        conn.on('ready', () => {
            conn.shell((err, stream) => {
                if (err) {
                    conn.end();
                    return reject(err);
                }

                let output = '';
                const responses = job.responses || {};
                const END_MARKER = `GEMINI_TASK_COMPLETE_MARKER_${job.id}`;
                let responseSent = false;

                const cleanupAndResolve = (status = 'completed') => {
                    clearTimeout(jobTimeout);
                    output = output.replace(END_MARKER, '').trim();
                    const result = { output, exitCode: 0 };
                    queue.updateJobStatus(jobId, status, result);
                    try {
                        stream.end();
                        conn.end();
                    } catch(e) {/* ignore */}
                    resolve(result);
                };

                const jobTimeout = setTimeout(() => {
                    cleanupAndResolve('failed');
                }, (job.timeout ? job.timeout * 1000 : config.interactiveCommandTimeout));

                stream.on('close', () => {
                    if (!output.includes(END_MARKER)) {
                        cleanupAndResolve('failed');
                    }
                });

                stream.on('data', (data) => {
                    const chunk = data.toString();
                    output += chunk;

                    if (output.includes(END_MARKER)) {
                        cleanupAndResolve();
                        return;
                    }

                    if (!responseSent && job.autoRespond) {
                        const lowerChunk = chunk.toLowerCase();
                        let responseToSend = null;
                        
                        // Chercher une réponse personnalisée
                        for (const [pattern, response] of Object.entries(responses)) {
                            if (lowerChunk.includes(pattern.toLowerCase())) {
                                responseToSend = response;
                                queue.log('info', `Réponse interactive: ${pattern} -> ${response}`);
                                break;
                            }
                        }
                        
                        // Sinon, chercher une réponse par défaut
                        if (!responseToSend) {
                            for (const [pattern, response] of Object.entries(INTERACTIVE_RESPONSES)) {
                                if (response && lowerChunk.includes(pattern.toLowerCase())) {
                                    responseToSend = response;
                                    queue.log('info', `Réponse auto: ${pattern} -> ${response}`);
                                    break;
                                }
                            }
                        }

                        // Si une réponse a été trouvée, l'envoyer
                        if (responseToSend) {
                            stream.write(responseToSend + '\n');
                            responseSent = true;
                            // Envoyer le marqueur de fin juste après
                            setTimeout(() => stream.write(`echo "${END_MARKER}"; exit\n`), 100);
                        }
                    }
                });

                stream.stderr.on('data', (data) => {
                    output += `[STDERR] ${data.toString()}`;
                });

                // Envoyer uniquement la commande initiale
                stream.write(job.cmd + '\n');
            });
        });

        conn.on('error', (err) => {
            reject(err);
        });

        const connectConfig = { 
            host: serverConfig.host, 
            port: 22, 
            username: serverConfig.user, 
            readyTimeout: 20000 
        };

        (async () => {
            if (serverConfig.keyPath) {
                try {
                    connectConfig.privateKey = await fs.readFile(serverConfig.keyPath);
                } catch (err) {
                    reject(new Error(`Impossible de lire la clé SSH: ${err.message}`));
                    return;
                }
            } else if (serverConfig.password) {
                connectConfig.password = serverConfig.password;
            } else {
                reject(new Error("Aucune méthode d'authentification configurée"));
                return;
            }

            conn.connect(connectConfig);
        })();
    });
}


// Nouvelle fonction pour exécuter plusieurs commandes en séquence
async function executeCommandSequence(jobId) {
    const job = queue.getJob(jobId);
    if (!job) return queue.log('error', `Tâche introuvable: ${jobId}`);
    
    const results = [];
    let connection = null;
    
    try {
        const serverConfig = await serverManager.getServer(job.alias);
        queue.updateJobStatus(jobId, 'running');
        
        // Obtenir une connexion du pool
        connection = await sshPool.getConnection(job.alias, serverConfig);
        
        // Exécuter chaque commande en séquence
        for (let i = 0; i < job.commands.length; i++) {
            const cmd = job.commands[i];
            const stepJob = {
                ...job,
                cmd: typeof cmd === 'string' ? cmd : cmd.command,
                timeout: cmd.timeout || job.timeout,
                continueOnError: cmd.continueOnError || job.continueOnError
            };
            
            try {
                queue.log('info', `Exécution étape ${i+1}/${job.commands.length}: ${stepJob.cmd}`);
                const result = await executeWithPooledConnection(connection, stepJob, `${jobId}_step_${i}`);
                results.push({ 
                    step: i + 1, 
                    command: stepJob.cmd, 
                    success: true, 
                    ...result 
                });
            } catch (err) {
                results.push({ 
                    step: i + 1, 
                    command: stepJob.cmd, 
                    success: false, 
                    error: err.message 
                });
                
                if (!stepJob.continueOnError) {
                    throw new Error(`Échec à l'étape ${i+1}: ${err.message}`);
                }
            }
        }
        
        queue.updateJobStatus(jobId, 'completed', { results });
        
    } catch (err) {
        queue.updateJobStatus(jobId, 'failed', { 
            error: err.message, 
            results 
        });
    } finally {
        if (connection) {
            sshPool.releaseConnection(connection.id);
        }
    }
}

// Obtenir les stats du pool
function getPoolStats() {
    return sshPool.getStats();
}

function parseSystemResources(output) {
    const resources = {
        load_average: null,
        memory: null,
        disk: null
    };
    const lines = output.split('\n');

    try {
        const uptimeLine = lines.find(line => line.includes('load average:'));
        if (uptimeLine) {
            const parts = uptimeLine.split('load average:')[1];
            resources.load_average = parts.split(',').map(s => s.trim());
        }

        const memLine = lines.find(line => line.trim().startsWith('Mem:'));
        if (memLine) {
            const parts = memLine.trim().split(/\s+/);
            resources.memory = {
                total: parts[1],
                used: parts[2],
                free: parts[3],
                available: parts[6]
            };
        }

        const diskLine = lines.find(line => line.startsWith('/dev/'));
        if (diskLine) {
            const parts = diskLine.trim().split(/\s+/);
            resources.disk = {
                filesystem: parts[0],
                total: parts[1],
                used: parts[2],
                available: parts[3],
                use_percent: parts[4]
            };
        }
    } catch (e) {
        // En cas d'erreur de parsing, retourner les données brutes
        return { raw_output: output, parsing_error: e.message };
    }

    return resources;
}

function parseServicesStatus(output) {
    const services = {
        systemd: [],
        docker: [],
        pm2: []
    };

    try {
        const sections = output.split(/---DOCKER---|---PM2---/);
        const systemdRaw = sections[0] || '';
        const dockerRaw = sections[1] || '';
        const pm2Raw = sections[2] || '';

        // Parse systemd
        if (systemdRaw) {
            const lines = systemdRaw.trim().split('\n');
            lines.forEach(line => {
                const match = line.match(/^(\S+)\s+loaded\s+active\s+running/);
                if (match && match[1]) {
                    services.systemd.push({ name: match[1], status: 'running' });
                }
            });
        }

        // Parse Docker
        if (dockerRaw) {
            const lines = dockerRaw.trim().split('\n').filter(Boolean);
            lines.forEach(line => {
                const parts = line.split(': ');
                if (parts.length >= 2) {
                    services.docker.push({ name: parts[0].trim(), status: parts.slice(1).join(': ').trim() });
                }
            });
        }

        // Parse PM2
        if (pm2Raw) {
            const lines = pm2Raw.trim().split('\n');
            const tableStartIndex = lines.findIndex(line => line.includes('│ id │'));
            if (tableStartIndex !== -1) {
                const tableBody = lines.slice(tableStartIndex + 2, -1); // Skip header, separator, and footer
                tableBody.forEach(line => {
                    const columns = line.split('│').map(s => s.trim()).filter(Boolean);
                    if (columns.length >= 4) { // id, name, namespace, status
                        services.pm2.push({ id: columns[0], name: columns[1], status: columns[3] });
                    }
                });
            }
        }
    } catch (e) {
        return { raw_output: output, parsing_error: e.message };
    }

    return services;
}

function parseApiHealth(output) {
    try {
        const [codeStr, timeStr] = output.split(':');
        const http_code = parseInt(codeStr, 10);
        const response_time_ms = parseFloat(timeStr) * 1000;

        return {
            status: http_code >= 200 && http_code < 300 ? 'UP' : 'DOWN',
            http_code: http_code,
            response_time_ms: Math.round(response_time_ms)
        };
    } catch (e) {
        return { status: 'ERROR', http_code: 0, response_time_ms: 0, parsing_error: e.message, raw_output: output };
    }
}

export default { 
    executeCommand, 
    executeCommandSequence, 
    getPoolStats, 
    parseSystemResources, 
    parseServicesStatus, 
    parseApiHealth 
};
