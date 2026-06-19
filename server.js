const DEBUG = process.env.MCP_DEBUG === 'true';

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import queue from './queue.js';
import servers from './servers.js';
import sftp from './sftp.js';
import ssh from './ssh.js';
import history from './history.js';
import config from './config.js';
import apis from './apis.js';
import sshPool from './sshPool.js';
import utils from './utils.js';

if (DEBUG) {
    console.error("✅ Tous les modules importés");
    console.error("⏳ Initialisation de la queue...");
}

await queue.init();

if (DEBUG) console.error("✅ Queue initialisée");

// Vérification des secrets en clair
try {
    const serverList = await servers.listServers();
    for (const [alias, config] of Object.entries(serverList)) {
        if (config.password) {
            console.error(`[SECURITY WARN] Mot de passe en clair détecté pour le serveur '${alias}'. Utilisez une clé SSH ou Vaultwarden.`);
        }
    }
    const apiList = await apis.listApis();
    for (const [alias, config] of Object.entries(apiList)) {
        if (config.api_key || config.htpasswd_pass) {
            console.error(`[SECURITY WARN] Secret en clair détecté pour l'API '${alias}'. Utilisez Vaultwarden.`);
        }
    }
} catch (e) { /* silencieux, pas bloquant */ }

const server = new McpServer({
    name: "orchestrator",
    version: "9.0.1",
    description: "Serveur pour l'orchestration de tâches distantes avec exécution hybride et configuration flexible."
});

if (DEBUG) console.error("✅ Serveur MCP créé");

server.registerTool(
    "system_diagnostics",
    {
        title: "Diagnostic système complet",
        description: "Exécute un diagnostic complet du système MCP.",
        inputSchema: z.object({
            verbose: z.boolean().optional().default(false)
        })
    },
    async (params) => {
        const stats = {
            queue: queue.getStats(),
            pool: ssh.getPoolStats(),
            servers: await servers.listServers(),
            apis: await apis.listApis(),
            crashed: queue.getCrashedJobs().length
        };

        if (params.verbose) {
            stats.logs = queue.getLogs({ limit: 20 });
        }

        return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
    }
);


// --- OUTILS DE GESTION DES SERVEURS ---

server.registerTool(
    "server_add",
    {
        title: "Ajouter/Modifier un alias de serveur",
        description: "Enregistre ou met à jour les informations de connexion d'un serveur. Vous devez fournir soit un chemin de clé, soit un mot de passe.",
        inputSchema: z.object({
            alias: z.string().describe("Nom court et unique pour le serveur (ex: vps_production)"),
            host: z.string().describe("Adresse IP ou nom d'hôte du serveur"),
            user: z.string().describe("Nom d'utilisateur pour la connexion"),
            keyPath: z.string().optional().describe("Chemin absolu vers la clé privée SSH."),
            password: z.string().optional().describe("Mot de passe pour la connexion.")
        }).refine(data => data.keyPath || data.password, {
            message: "Vous devez fournir au moins une méthode d'authentification ('keyPath' ou 'password')."
        })
    },
    async (params) => {
        try {
            const { alias, ...serverConfig } = params;
            const result = await servers.addServer(alias, serverConfig);
            return { content: [{ type: "text", text: result.message }] };
        } catch (e) {
            const errorPayload = {
                toolName: "server_add",
                errorCode: "TOOL_EXECUTION_ERROR",
                errorMessage: e.message
            };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "server_list",
    {
        title: "Lister les alias de serveurs",
        description: "Affiche la liste de tous les alias de serveurs configurés avec leurs détails.",
        inputSchema: z.object({})
    },
    async () => {
        const serverList = await servers.listServers();
        return { content: [{ type: "text", text: JSON.stringify(serverList, null, 2) }] };
    }
);

server.registerTool(
    "server_remove",
    {
        title: "Supprimer un alias de serveur",
        description: "Supprime un alias de serveur de la configuration.",
        inputSchema: z.object({
            alias: z.string().describe("Nom de l'alias à supprimer")
        })
    },
    async (params) => {
        try {
            const result = await servers.removeServer(params.alias);
            return { content: [{ type: "text", text: result.message }] };
        } catch (e) {
            const errorPayload = {
                toolName: "server_remove",
                errorCode: "TOOL_EXECUTION_ERROR",
                errorMessage: e.message
            };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

// --- OUTILS DE GESTION D'API ---
server.registerTool(
    "api_add",
    {
        title: "Ajouter une API au catalogue",
        description: "Ajoute ou met à jour une API dans le catalogue de monitoring.",
        inputSchema: z.object({
            alias: z.string().describe("Alias unique pour l'API."),
            url: z.string().url().describe("URL de base de l'API, incluant le port si nécessaire."),
            health_check_endpoint: z.string().optional().describe("Endpoint spécifique pour le test de santé (ex: /health)."),
            health_check_method: z.enum(['GET', 'POST']).optional().default('GET').describe("Méthode HTTP pour le test de santé."),
            auth_method: z.enum(['api_key', 'htpasswd', 'both', 'none']).optional().default('none').describe("Méthode d'authentification."),
            api_key: z.string().optional().describe("Clé API si nécessaire."),
            auth_header_name: z.string().optional().default('Authorization').describe("Nom du header pour la clé API."),
            auth_scheme: z.string().optional().default('Bearer').describe("Schéma d'authentification (ex: Bearer). Mettre à '' si non applicable."),
            htpasswd_user: z.string().optional().describe("Nom d'utilisateur pour l'authentification Basic (htpasswd)."),
            htpasswd_pass: z.string().optional().describe("Mot de passe pour l'authentification Basic (htpasswd)."),
            notes: z.string().optional().describe("Notes additionnelles.")
        })
    },
    async (params) => {
        try {
            const { alias, ...apiConfig } = params;
            const result = await apis.addApi(alias, apiConfig);
            return { content: [{ type: "text", text: result.message }] };
        } catch (e) {
            const errorPayload = {
                toolName: "api_add",
                errorCode: "TOOL_EXECUTION_ERROR",
                errorMessage: e.message
            };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "api_list",
    {
        title: "Lister les APIs du catalogue",
        description: "Affiche toutes les APIs configurées dans le catalogue.",
        inputSchema: z.object({})
    },
    async () => {
        const apiList = await apis.listApis();
        return { content: [{ type: "text", text: JSON.stringify(apiList, null, 2) }] };
    }
);

server.registerTool(
    "api_remove",
    {
        title: "Supprimer une API du catalogue",
        description: "Supprime une API du catalogue en utilisant son alias.",
        inputSchema: z.object({
            alias: z.string().describe("Alias de l'API à supprimer.")
        })
    },
    async (params) => {
        try {
            const result = await apis.removeApi(params.alias);
            return { content: [{ type: "text", text: result.message }] };
        } catch (e) {
            const errorPayload = {
                toolName: "api_remove",
                errorCode: "TOOL_EXECUTION_ERROR",
                errorMessage: e.message
            };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "api_check",
    {
        title: "Vérifier la santé d'une API via son alias",
        description: "Lance un test de santé sur une API du catalogue.",
        inputSchema: z.object({
            alias: z.string().describe("Alias de l'API à tester."),
            server_alias: z.string().describe("Alias du serveur depuis lequel lancer le test.")
        })
    },
    async (params) => {
        try {
            const apiConfig = await apis.getApi(params.alias);
            const endpoint = apiConfig.health_check_endpoint || '';
            const url = `${apiConfig.url}${endpoint}`;
            const method = apiConfig.health_check_method || 'GET';

            let curlCmd = `curl -X ${method} -o /dev/null -s -w '%{http_code}:%{time_total}'`;

            // Gérer l'authentification htpasswd
            if ((apiConfig.auth_method === 'htpasswd' || apiConfig.auth_method === 'both') && apiConfig.htpasswd_user && apiConfig.htpasswd_pass) {
                const credentials = `${apiConfig.htpasswd_user}:${apiConfig.htpasswd_pass}`;
                curlCmd += ` -u ${utils.escapeShellArg(credentials)}`;
            }

            // Gérer l'authentification par clé API
            if ((apiConfig.auth_method === 'api_key' || apiConfig.auth_method === 'both') && apiConfig.api_key) {
                const scheme = apiConfig.auth_scheme ? `${apiConfig.auth_scheme} ` : '';
                const headerValue = `${apiConfig.auth_header_name || 'Authorization'}: ${scheme}${apiConfig.api_key}`;
                curlCmd += ` -H ${utils.escapeShellArg(headerValue)}`;
            }

            curlCmd += ` ${utils.escapeShellArg(url)}`;

            const job = queue.addJob({ type: 'ssh', alias: params.server_alias, cmd: curlCmd });
            ssh.executeCommand(job.id);
            const result = await waitForJobCompletion(job.id, config.syncTimeout);

            if (!result || result.status !== 'completed') {
                throw new Error(result ? result.error : `Timeout de la commande de monitoring pour ${params.alias}`);
            }

            const parsedOutput = ssh.parseApiHealth(result.output);
            return { content: [{ type: "text", text: JSON.stringify(parsedOutput, null, 2) }] };
        } catch (e) {
            const errorPayload = {
                toolName: "api_check",
                errorCode: "TOOL_EXECUTION_ERROR",
                errorMessage: e.message
            };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

// --- NOUVEAUX OUTILS DE MONITORING ---
server.registerTool(
    "get_system_resources",
    {
        title: "Obtenir les ressources système d'un VPS",
        description: "Récupère les métriques système vitales (CPU, RAM, Disque) d'un serveur.",
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur cible.")
        })
    },
    async (params) => {
        try {
            const job = queue.addJob({
                type: 'ssh',
                alias: params.alias,
                cmd: "uptime && free -h && df -h /"
            });
            ssh.executeCommand(job.id);
            const result = await waitForJobCompletion(job.id, config.syncTimeout);

            if (!result || result.status !== 'completed') {
                throw new Error(result ? result.error : `Timeout de la commande de monitoring pour ${params.alias}`);
            }

            const parsedOutput = ssh.parseSystemResources(result.output);
            return { content: [{ type: "text", text: JSON.stringify(parsedOutput, null, 2) }] };
        } catch (e) {
            const errorPayload = {
                toolName: "get_system_resources",
                errorCode: "MONITORING_ERROR",
                errorMessage: e.message
            };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "get_services_status",
    {
        title: "Obtenir le statut des services d'un VPS",
        description: "Récupère le statut de tous les services connus (systemd, Docker, PM2) sur un serveur.",
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur cible.")
        })
    },
    async (params) => {
        try {
            const cmd = "systemctl --type=service --state=running --no-pager ; echo '---DOCKER---' ; docker ps --format '{{.Names}}: {{.Status}}' ; echo '---PM2---' ; pm2 list";
            const job = queue.addJob({
                type: 'ssh',
                alias: params.alias,
                cmd: cmd
            });
            ssh.executeCommand(job.id);
            const result = await waitForJobCompletion(job.id, config.syncTimeout);

            if (!result || result.status !== 'completed') {
                throw new Error(result ? result.error : `Timeout de la commande de monitoring pour ${params.alias}`);
            }

            const parsedOutput = ssh.parseServicesStatus(result.output);
            return { content: [{ type: "text", text: JSON.stringify(parsedOutput, null, 2) }] };
        } catch (e) {
            const errorPayload = {
                toolName: "get_services_status",
                errorCode: "MONITORING_ERROR",
                errorMessage: e.message
            };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "check_api_health",
    {
        title: "Vérifier la santé d'une API",
        description: "Vérifie la disponibilité et le temps de réponse d'un endpoint HTTP/S.",
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur depuis lequel lancer le test."),
            url: z.string().url().describe("URL complète de l'endpoint à tester.")
        })
    },
    async (params) => {
        try {
            const cmd = `curl -o /dev/null -s -w '%{http_code}:%{time_total}' ${utils.escapeShellArg(params.url)}`;
            const job = queue.addJob({
                type: 'ssh',
                alias: params.alias,
                cmd: cmd
            });
            ssh.executeCommand(job.id);
            const result = await waitForJobCompletion(job.id, config.syncTimeout);

            if (!result || result.status !== 'completed') {
                throw new Error(result ? result.error : `Timeout de la commande de monitoring pour ${params.alias}`);
            }

            const parsedOutput = ssh.parseApiHealth(result.output);
            return { content: [{ type: "text", text: JSON.stringify(parsedOutput, null, 2) }] };
        } catch (e) {
            const errorPayload = {
                toolName: "check_api_health",
                errorCode: "MONITORING_ERROR",
                errorMessage: e.message
            };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "get_fail2ban_status",
    {
        title: "Obtenir le statut de Fail2Ban",
        description: "Récupère les informations du service Fail2Ban, pour toutes les jails ou une jail spécifique.",
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur cible."),
            jail: z.string().optional().describe("Nom d'une jail spécifique à inspecter (ex: sshd). Laissez vide pour un statut général.")
        })
    },
    async (params) => {
        try {
            const cmd = `sudo fail2ban-client status ${params.jail || ''}`.trim();
            const job = queue.addJob({
                type: 'ssh',
                alias: params.alias,
                cmd: cmd
            });
            ssh.executeCommand(job.id);
            const result = await waitForJobCompletion(job.id, config.syncTimeout);

            if (!result || result.status !== 'completed') {
                throw new Error(result ? result.error : `Timeout de la commande de monitoring pour ${params.alias}`);
            }

            // Pour cette version, nous retournons la sortie brute.
            return { content: [{ type: "text", text: result.output }] };
        } catch (e) {
            const errorPayload = {
                toolName: "get_fail2ban_status",
                errorCode: "MONITORING_ERROR",
                errorMessage: e.message
            };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);


// --- LOGIQUE D'ATTENTE HYBRIDE ---
// --- LOGIQUE D'ATTENTE HYBRIDE ---
async function waitForJobCompletion(jobId, timeout) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        const interval = setInterval(() => {
            const job = queue.getJob(jobId);
            if (!job) {
                clearInterval(interval);
                resolve(null);
                return;
            }
            if (job.status === 'completed' || job.status === 'failed') {
                clearInterval(interval);
                resolve(job);
            } else if (timeout > 0 && Date.now() - startTime > timeout) {
                clearInterval(interval);
                resolve(null);
            }
        }, 200);
    });
}

function buildAsyncMessage(job, toolType) {
    const waitCmd = `Utilisez task_wait avec l'ID ${job.id} pour attendre la fin et récupérer le résultat.`;
    return `Tâche ${toolType} ${job.id} passée en arrière-plan (timeout dépassé). Statut actuel: ${job.status || 'pending'}.\n${waitCmd}`;
}

// --- EXÉCUTION DE TÂCHES ---
server.registerTool(
    "task_transfer",
    {
        title: "Transférer un fichier ou dossier (SFTP)",
        description: `Lance un transfert SFTP. Si la tâche prend moins de ${config.syncTimeout / 1000}s, le résultat est direct. Sinon, elle passe en arrière-plan.`,
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur cible."),
            direction: z.enum(['upload', 'download']),
            local: z.string().describe("Chemin absolu local."),
            remote: z.string().describe("Chemin absolu distant."),
            force: z.boolean().optional().default(false).describe("Écraser les fichiers existants sans confirmation."),
            rappel: z.number().optional().describe("Définit un rappel en secondes.")
        })
    },
    async (params) => {
        const job = queue.addJob({ type: 'sftp', ...params, status: 'pending' });
        history.logTask(job);
        sftp.executeTransfer(job.id);

        const finalJob = await waitForJobCompletion(job.id, config.syncTimeout);
        if (finalJob) {
            return {
                content: [{
                    type: "text", text: `Résultat direct (tâche ${finalJob.id}):
${JSON.stringify(finalJob, null, 2)}`
                }]
            };
        } else {
            return { content: [{ type: "text", text: buildAsyncMessage(job, 'de transfert') }] };
        }
    }
);

server.registerTool(
    "task_exec",
    {
        title: "Exécuter une commande à distance (SSH)",
        description: `Exécute une commande SSH. Si la tâche prend moins de ${config.syncTimeout / 1000}s, le résultat est direct. Sinon, elle passe en arrière-plan.`,
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur cible."),
            cmd: z.string().describe("La commande complète à exécuter."),
            timeout: z.number().optional().describe("Timeout en secondes. 0 = pas de limite. Défaut: 600s (10 min)."),
            rappel: z.number().optional().describe("Définit un rappel en secondes.")
        })
    },
    async (params) => {
        const job = queue.addJob({ type: 'ssh', ...params, status: 'pending' });
        history.logTask(job);
        ssh.executeCommand(job.id);

        const finalJob = await waitForJobCompletion(job.id, config.syncTimeout);
        if (finalJob) {
            return {
                content: [{
                    type: "text", text: `Résultat direct (tâche ${finalJob.id}):
${finalJob.output || JSON.stringify(finalJob, null, 2)}`
                }]
            };
        } else {
            return { content: [{ type: "text", text: buildAsyncMessage(job, 'd\'exécution') }] };
        }
    }
);

// --- OUTILS DE SUIVI ET HISTORIQUE ---
function formatJobForDisplay(job) {
    const displayJob = { ...job };
    if (job.status === 'running' && job.reminderAt && new Date() > new Date(job.reminderAt)) {
        displayJob.reminder = "ATTENTION: Le temps de rappel est écoulé. La tâche est peut-être terminée ou bloquée.";
    }
    return displayJob;
}


server.registerTool(
    "task_queue",
    {
        title: "Voir la file d'attente des tâches",
        description: "Affiche le statut de toutes les tâches, avec des rappels pour les tâches longues.",
        inputSchema: z.object({})
    },
    async () => {
        const queueState = queue.getQueue();
        const displayQueue = Object.values(queueState).map(formatJobForDisplay);
        return { content: [{ type: "text", text: JSON.stringify(displayQueue, null, 2) }] };
    }
);

server.registerTool(
    "task_status",
    {
        title: "Consulter une tâche par son ID",
        description: "Récupère les détails d'une seule tâche, avec un rappel si nécessaire.",
        inputSchema: z.object({
            id: z.string().describe("L'ID de la tâche à consulter.")
        })
    },
    async (params) => {
        const job = queue.getJob(params.id);
        if (!job) return { content: [{ type: "text", text: `ERREUR: Tâche '${params.id}' introuvable.` }], isError: true };

        const displayJob = formatJobForDisplay(job);
        return { content: [{ type: "text", text: JSON.stringify(displayJob, null, 2) }] };
    }
);

server.registerTool(
    "task_history",
    {
        title: "Consulter l'historique des tâches",
        description: "Affiche les dernières tâches lancées. Peut être filtré par alias.",
        inputSchema: z.object({
            alias: z.string().optional().describe("Filtre l'historique pour ne montrer que les tâches d'un alias spécifique.")
        })
    },
    async (params) => {
        const historyLogs = await history.getHistory(params);
        return { content: [{ type: "text", text: JSON.stringify(historyLogs, null, 2) }] };
    }
);

// --- NOUVEAUX OUTILS POUR LES FONCTIONNALITÉS AVANCÉES ---

server.registerTool(
    "task_transfer_multi",
    {
        title: "Transférer plusieurs fichiers/dossiers (SFTP)",
        description: "Lance des transferts SFTP multiples avec support de patterns glob (*, ?, []).",
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur cible."),
            direction: z.enum(['upload', 'download']),
            files: z.array(z.object({
                local: z.string().describe("Chemin local ou pattern glob (ex: /home/*.txt)"),
                remote: z.string().describe("Chemin distant")
            })).describe("Liste des fichiers à transférer"),
            force: z.boolean().optional().default(false).describe("Écraser les fichiers existants sans confirmation."),
            rappel: z.number().optional().describe("Définit un rappel en secondes.")
        })
    },
    async (params) => {
        const job = queue.addJob({
            type: 'sftp',
            ...params,
            status: 'pending',
            files: params.files
        });
        history.logTask(job);
        sftp.executeMultiTransfer(job.id);

        const finalJob = await waitForJobCompletion(job.id, config.syncTimeout);
        if (finalJob) {
            return { content: [{ type: "text", text: `Résultat transferts multiples (tâche ${finalJob.id}):\n${JSON.stringify(finalJob, null, 2)}` }] };
        } else {
            return { content: [{ type: "text", text: buildAsyncMessage(job, 'de transferts multiples') }] };
        }
    }
);

server.registerTool(
    "task_exec_interactive",
    {
        title: "Exécuter une commande interactive (SSH)",
        description: "Exécute une commande SSH avec gestion des prompts interactifs (yes/no, passwords, etc.).",
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur cible."),
            cmd: z.string().describe("La commande à exécuter."),
            interactive: z.boolean().optional().default(true).describe("Mode interactif."),
            autoRespond: z.boolean().optional().default(true).describe("Répondre automatiquement aux prompts standards."),
            responses: z.record(z.string()).optional().describe("Réponses personnalisées aux prompts (clé: pattern, valeur: réponse)."),
            timeout: z.number().optional().describe("Timeout en secondes. 0 = pas de limite. Défaut: 300s (5 min)."),
            rappel: z.number().optional().describe("Définit un rappel en secondes.")
        })
    },
    async (params) => {
        const job = queue.addJob({
            type: 'ssh',
            ...params,
            status: 'pending',
            interactive: params.interactive,
            autoRespond: params.autoRespond
        });
        history.logTask(job);
        ssh.executeCommand(job.id);

        const finalJob = await waitForJobCompletion(job.id, params.timeout || config.syncTimeout);
        if (finalJob) {
            return { content: [{ type: "text", text: `Résultat commande interactive (tâche ${finalJob.id}):\n${finalJob.output || JSON.stringify(finalJob, null, 2)}` }] };
        } else {
            return { content: [{ type: "text", text: buildAsyncMessage(job, 'interactive') }] };
        }
    }
);

server.registerTool(
    "task_exec_sequence",
    {
        title: "Exécuter une séquence de commandes (SSH)",
        description: "Exécute plusieurs commandes SSH en séquence sur le même serveur.",
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur cible."),
            commands: z.array(z.union([
                z.string(),
                z.object({
                    command: z.string(),
                    timeout: z.number().optional(),
                    continueOnError: z.boolean().optional()
                })
            ])).min(1).describe("Liste des commandes à exécuter en séquence (minimum 1)."),
            continueOnError: z.boolean().optional().default(false).describe("Continuer même si une commande échoue."),
            timeout: z.number().optional().describe("Timeout global en secondes. 0 = pas de limite. Défaut: 600s (10 min)."),
            rappel: z.number().optional().describe("Définit un rappel en secondes.")
        })
    },
    async (params) => {
        const job = queue.addJob({
            type: 'ssh_sequence',
            ...params,
            status: 'pending'
        });
        history.logTask(job);
        ssh.executeCommandSequence(job.id);

        const seqTimeout = params.timeout === 0 ? 0 : (params.timeout ? params.timeout * 1000 : config.syncTimeout * params.commands.length);
        const finalJob = await waitForJobCompletion(job.id, seqTimeout);
        if (finalJob) {
            return { content: [{ type: "text", text: `Résultat séquence (tâche ${finalJob.id}):\n${JSON.stringify(finalJob, null, 2)}` }] };
        } else {
            return { content: [{ type: "text", text: buildAsyncMessage(job, 'de séquence') }] };
        }
    }
);

server.registerTool(
    "pool_stats",
    {
        title: "Statistiques du pool de connexions SSH",
        description: "Affiche les statistiques du pool de connexions SSH persistantes.",
        inputSchema: z.object({})
    },
    async () => {
        const stats = ssh.getPoolStats();
        return { content: [{ type: "text", text: `Pool de connexions SSH:\n${JSON.stringify(stats, null, 2)}` }] };
    }
);

server.registerTool(
    "queue_stats",
    {
        title: "Statistiques de la queue",
        description: "Affiche les statistiques détaillées de la queue de tâches.",
        inputSchema: z.object({})
    },
    async () => {
        const stats = queue.getStats();
        const crashed = queue.getCrashedJobs();
        const result = {
            stats,
            crashedJobs: crashed.length,
            canRetry: crashed.map(j => ({ id: j.id, type: j.type, crashedAt: j.crashedAt }))
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.registerTool(
    "task_retry",
    {
        title: "Réessayer une tâche échouée",
        description: "Relance une tâche qui a échoué ou crashé.",
        inputSchema: z.object({
            id: z.string().describe("L'ID de la tâche à réessayer.")
        })
    },
    async (params) => {
        try {
            const newJob = await queue.retryJob(params.id);

            // Relancer selon le type
            if (newJob.type === 'sftp') {
                sftp.executeTransfer(newJob.id);
            } else if (newJob.type === 'ssh') {
                ssh.executeCommand(newJob.id);
            } else if (newJob.type === 'ssh_sequence') {
                ssh.executeCommandSequence(newJob.id);
            }

            return { content: [{ type: "text", text: `Tâche ${params.id} relancée avec le nouvel ID: ${newJob.id}` }] };
        } catch (e) {
            const errorPayload = {
                toolName: "task_retry",
                errorCode: "TOOL_EXECUTION_ERROR",
                errorMessage: e.message
            };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "task_logs",
    {
        title: "Consulter les logs système",
        description: "Affiche les logs du système MCP.",
        inputSchema: z.object({
            level: z.enum(['error', 'warn', 'info', 'debug']).optional().describe("Filtrer par niveau de log."),
            search: z.string().optional().describe("Rechercher dans les messages."),
            limit: z.number().optional().default(50).describe("Nombre de logs à afficher.")
        })
    },
    async (params) => {
        const logs = queue.getLogs({
            level: params.level,
            search: params.search
        }).slice(-params.limit);
        return { content: [{ type: "text", text: JSON.stringify(logs, null, 2) }] };
    }
);

// --- NOUVEAUX OUTILS DE LOGS (v8) ---

server.registerTool(
    "get_pm2_logs",
    {
        title: "Récupérer les logs PM2",
        description: "Raccourci pour récupérer les logs PM2 d'une application spécifique ou de toutes les apps.",
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur cible."),
            app: z.string().optional().describe("Nom de l'application PM2 (optionnel, toutes par défaut)."),
            lines: z.number().optional().default(100).describe("Nombre de lignes à récupérer."),
            errors: z.boolean().optional().default(false).describe("Récupérer uniquement les erreurs (stderr).")
        })
    },
    async (params) => {
        let cmd = 'pm2 logs';
        if (params.app) cmd += ` ${params.app}`;
        if (params.errors) cmd += ' --err';
        cmd += ` --lines ${params.lines} --nostream`;

        const job = queue.addJob({ type: 'ssh', alias: params.alias, cmd: cmd, streaming: false });
        history.logTask(job);
        ssh.executeCommand(job.id);

        const finalJob = await waitForJobCompletion(job.id, config.syncTimeout);
        if (finalJob) {
            return { content: [{ type: "text", text: `📋 Logs PM2${params.app ? ` (${params.app})` : ''} - ${finalJob.lineCount || 0} lignes:\n\n${finalJob.output || '(vide)'}` }] };
        } else {
            return { content: [{ type: "text", text: buildAsyncMessage(job, 'PM2 logs') }] };
        }
    }
);

server.registerTool(
    "get_docker_logs",
    {
        title: "Récupérer les logs Docker",
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur cible."),
            container: z.string().describe("Nom ou ID du container Docker."),
            lines: z.number().optional().default(100).describe("Nombre de lignes à récupérer."),
            since: z.string().optional().describe("Logs depuis (ex: '5m', '1h', '2024-01-01')."),
            timestamps: z.boolean().optional().default(false).describe("Afficher les timestamps.")
        })
    },
    async (params) => {
        let cmd = `docker logs --tail ${params.lines}`;
        if (params.since) cmd += ` --since ${params.since}`;
        if (params.timestamps) cmd += ' --timestamps';
        cmd += ` ${utils.escapeShellArg(params.container)}`;

        const job = queue.addJob({ type: 'ssh', alias: params.alias, cmd: cmd, streaming: false });
        history.logTask(job);
        ssh.executeCommand(job.id);

        const finalJob = await waitForJobCompletion(job.id, config.syncTimeout);
        if (finalJob) {
            return { content: [{ type: "text", text: `🐳 Logs Docker (${params.container}) - ${finalJob.lineCount || 0} lignes:\n\n${finalJob.output || '(vide)'}` }] };
        } else {
            return { content: [{ type: "text", text: buildAsyncMessage(job, 'Docker logs') }] };
        }
    }
);

server.registerTool(
    "tail_file",
    {
        title: "Afficher les dernières lignes d'un fichier",
        description: "Équivalent de tail -n pour afficher les dernières lignes d'un fichier distant.",
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur cible."),
            filepath: z.string().describe("Chemin absolu du fichier à lire."),
            lines: z.number().optional().default(50).describe("Nombre de lignes à afficher.")
        })
    },
    async (params) => {
        const cmd = `tail -n ${params.lines} ${utils.escapeShellArg(params.filepath)}`;
        const job = queue.addJob({ type: 'ssh', alias: params.alias, cmd: cmd, streaming: false });
        history.logTask(job);
        ssh.executeCommand(job.id);

        const finalJob = await waitForJobCompletion(job.id, config.syncTimeout);
        if (finalJob) {
            return { content: [{ type: "text", text: `📄 Contenu de ${params.filepath} (${finalJob.lineCount || 0} lignes):\n\n${finalJob.output || '(vide)'}` }] };
        } else {
            return { content: [{ type: "text", text: buildAsyncMessage(job, 'tail') }] };
        }
    }
);

// --- OUTIL D'AIDE / GUIDE ---

server.registerTool(
    "help",
    {
        title: "Guide et documentation des outils",
        description: "Affiche la documentation complète d'un outil ou la liste de tous les outils disponibles.",
        inputSchema: z.object({
            tool: z.string().optional().describe("Nom de l'outil à documenter. Laissez vide pour la liste complète.")
        })
    },
    async (params) => {
        const allTools = [
            { name: "help", desc: "Guide et documentation des outils (celui-ci)." },
            { name: "system_diagnostics", desc: "Diagnostic complet du système MCP (queue, pool, serveurs, APIs)." },
            { name: "server_add", desc: "Ajouter/modifier un alias de serveur SSH." },
            { name: "server_list", desc: "Lister tous les serveurs configurés." },
            { name: "server_remove", desc: "Supprimer un alias de serveur." },
            { name: "api_add", desc: "Ajouter une API au catalogue de monitoring." },
            { name: "api_list", desc: "Lister toutes les APIs du catalogue." },
            { name: "api_remove", desc: "Supprimer une API du catalogue." },
            { name: "api_check", desc: "Test de santé d'une API via son alias (SSH curl)." },
            { name: "get_system_resources", desc: "Métriques CPU, RAM, Disque d'un serveur." },
            { name: "get_services_status", desc: "Statut des services systemd, Docker, PM2." },
            { name: "check_api_health", desc: "Test HTTP direct sur une URL." },
            { name: "get_fail2ban_status", desc: "Statut Fail2Ban (toutes les jails ou une spécifique)." },
            { name: "task_exec", desc: "Exécuter une commande SSH. Timeout paramétrable (0=infini)." },
            { name: "task_transfer", desc: "Transfert SFTP fichier/dossier. Paramètre force:true pour écraser." },
            { name: "task_exec_interactive", desc: "SSH avec prompts interactifs (yes/no, menus). Supporte regex dans responses." },
            { name: "task_exec_sequence", desc: "Séquence de commandes SSH sur le même serveur." },
            { name: "task_transfer_multi", desc: "Transferts SFTP multiples avec patterns glob." },
            { name: "task_queue", desc: "Voir toutes les tâches en cours/en attente." },
            { name: "task_status", desc: "Détail d'une tâche par son ID." },
            { name: "task_history", desc: "Historique des tâches, filtrable par alias." },
            { name: "task_retry", desc: "Relancer une tâche échouée ou crashée." },
            { name: "task_wait", desc: "Attendre la fin d'une tâche en arrière-plan (jusqu'à 600s)." },
            { name: "task_logs", desc: "Logs internes du système MCP." },
            { name: "queue_stats", desc: "Statistiques de la file d'attente." },
            { name: "pool_stats", desc: "Statistiques du pool de connexions SSH." },
            { name: "get_pm2_logs", desc: "Récupérer les logs PM2 d'une app." },
            { name: "get_docker_logs", desc: "Récupérer les logs d'un container Docker." },
            { name: "tail_file", desc: "Afficher les dernières lignes d'un fichier distant." }
        ];

        const envVars = [
            { var: "MCP_DATA_DIR", defaut: "~/.config/mcp-orchestrator", desc: "Dossier des fichiers de données (JSON)." },
            { var: "MCP_SYNC_TIMEOUT_S", defaut: "120", desc: "Délai en secondes avant passage en arrière-plan." },
            { var: "MCP_DEFAULT_CMD_TIMEOUT_S", defaut: "600", desc: "Timeout SSH par défaut (0=infini)." },
            { var: "MCP_INTERACTIVE_CMD_TIMEOUT_S", defaut: "300", desc: "Timeout mode interactif (0=infini)." },
            { var: "MCP_MAX_WAIT_TIMEOUT_S", defaut: "600", desc: "Timeout maximum pour task_wait." },
            { var: "MAX_CONNECTIONS_PER_SERVER", defaut: "5", desc: "Connexions SSH max par serveur." },
            { var: "MIN_CONNECTIONS_PER_SERVER", defaut: "1", desc: "Connexions SSH min par serveur." },
            { var: "IDLE_TIMEOUT", defaut: "300000", desc: "Délai avant fermeture connexion inactive (ms)." },
            { var: "KEEP_ALIVE_INTERVAL", defaut: "30000", desc: "Intervalle keepalive SSH (ms)." },
            { var: "MAX_QUEUE_SIZE", defaut: "1000", desc: "Nombre max de jobs dans la queue." },
            { var: "SAVE_INTERVAL", defaut: "5000", desc: "Intervalle de sauvegarde de la queue (ms)." },
            { var: "MCP_DEBUG", defaut: "false", desc: "Activer les logs de debug détaillés." },
            { var: "MCP_TRANSPORT", defaut: "stdio", desc: "Transport: stdio, http, ou both (v9+)." },
            { var: "MCP_HTTP_PORT", defaut: "3457", desc: "Port du serveur HTTP (si transport=http ou both)." }
        ];

        const usageTips = [
            "Pour les longues opérations: utilisez timeout:0 sur task_exec, puis task_wait pour récupérer le résultat.",
            "Transferts SFTP: si un fichier existe déjà, utilisez force:true pour l'écraser (sinon refusé).",
            "Mode interactif: passez un objet responses avec des patterns→réponses pour les prompts attendus.",
            "Les patterns dans responses supportent les regex. Ex: '[YyNn]\\\\?' → 'y'.",
            "Utilisez task_queue pour voir les jobs en cours, task_status <id> pour un job précis.",
            "Les jobs 'crashed' (rouges) sont réessayables avec task_retry."
        ];

        if (params.tool) {
            const tool = allTools.find(t => t.name === params.tool);
            if (!tool) {
                const errorPayload = { toolName: "help", errorCode: "UNKNOWN_TOOL", errorMessage: `Outil '${params.tool}' inconnu. Utilisez help sans paramètre pour la liste.` };
                return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
            }
            return { content: [{ type: "text", text: `Outil: ${tool.name}\nDescription: ${tool.desc}\n\nUtilisez help sans paramètre pour voir tous les outils et variables d'environnement.` }] };
        }

        const guide = `=== GUIDE MCP ORCHESTRATOR v9.0.1 ===

OUTILS DISPONIBLES (${allTools.length}):
${allTools.map(t => `  ${t.name}: ${t.desc}`).join('\n')}

VARIABLES D'ENVIRONNEMENT (.env):
${envVars.map(v => `  ${v.var} (défaut: ${v.defaut}) — ${v.desc}`).join('\n')}

ASTUCES D'UTILISATION:
${usageTips.map(t => `  • ${t}`).join('\n')}

Pour la doc complète: help tool:<nom> ou consultez le README.`;

        return { content: [{ type: "text", text: guide }] };
    }
);

// --- ATTENTE EXPLICITE ---

server.registerTool(
    "task_wait",
    {
        title: "Attendre la fin d'une tâche en arrière-plan",
        description: `Prend un ID de job et attend jusqu'à ${config.maxWaitTimeout / 1000}s que la tâche se termine, puis retourne le résultat.`,
        inputSchema: z.object({
            id: z.string().describe("L'ID de la tâche à attendre.")
        })
    },
    async (params) => {
        const existingJob = queue.getJob(params.id);
        if (!existingJob) {
            const errorPayload = {
                toolName: "task_wait",
                errorCode: "JOB_NOT_FOUND",
                errorMessage: `Tâche '${params.id}' introuvable.`
            };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }

        if (existingJob.status === 'completed' || existingJob.status === 'failed') {
            return { content: [{ type: "text", text: `Tâche ${params.id} déjà terminée:\n${JSON.stringify(existingJob, null, 2)}` }] };
        }

        const finalJob = await waitForJobCompletion(params.id, config.maxWaitTimeout);
        if (finalJob) {
            return { content: [{ type: "text", text: `Résultat tâche ${finalJob.id}:\n${JSON.stringify(finalJob, null, 2)}` }] };
        } else {
            return { content: [{ type: "text", text: `Tâche ${params.id} toujours en cours (peut-être terminée entre-temps). Réessayez task_wait.` }] };
        }
    }
);

// --- DÉMARRAGE DU SERVEUR ---
async function main() {
    if (DEBUG) console.error("🔌 Connexion du transport stdio...");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    if (DEBUG) console.error("🚀 Serveur stdio connecté et prêt !");
}

async function shutdown() {
    if (DEBUG) console.error("Arrêt du serveur...");
    await queue.shutdown();
    sshPool.closeAll();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((error) => {
    console.error("Erreur fatale du serveur:", error);
    process.exit(1);
});
