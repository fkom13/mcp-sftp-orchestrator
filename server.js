import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
console.error("✅ McpServer importé");
const DEBUG = process.env.MCP_DEBUG === 'true';

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
console.error("✅ StdioServerTransport importé");

import { z } from "zod";
console.error("✅ zod importé");

import queue from './queue.js';
console.error("✅ queue importé");

import servers from './servers.js';
console.error("✅ servers importé");

import sftp from './sftp.js';
console.error("✅ sftp importé");

import ssh from './ssh.js';
console.error("✅ ssh importé");

import history from './history.js';
console.error("✅ history importé");

import config from './config.js';
console.error("✅ config importé");

import apis from './apis.js';
if (DEBUG) {
    console.error("✅ apis importé");
    console.error("=== TOUS LES IMPORTS RÉUSSIS ===");
}

// ✅ INITIALISER EXPLICITEMENT ET ATTENDRE
const DEBUG = process.env.MCP_DEBUG === 'true';

if (DEBUG) console.error("⏳ Initialisation de la queue...");
await queue.init();
if (DEBUG) console.error("✅ Queue initialisée");

const server = new McpServer({
    name: "orchestrator",
    version: "8.0.0", // Version avec gestion du streaming
    description: "Serveur pour l'orchestration de tâches distantes avec exécution hybride et configuration flexible."
});

console.error("✅ Serveur MCP créé");

// Ajout de l'outil system_diagnostics avant les autres
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
console.error("✅ Serveur MCP créé");

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
            return { content: [{ type: "text", text: `ERREUR: ${e.message}` }], isError: true };
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
            return { content: [{ type: "text", text: `ERREUR: ${e.message}` }], isError: true };
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
                curlCmd += ` -u ${apiConfig.htpasswd_user}:${apiConfig.htpasswd_pass}`;
            }

            // Gérer l'authentification par clé API
            if ((apiConfig.auth_method === 'api_key' || apiConfig.auth_method === 'both') && apiConfig.api_key) {
                const scheme = apiConfig.auth_scheme ? `${apiConfig.auth_scheme} ` : '';
                curlCmd += ` -H '${apiConfig.auth_header_name || 'Authorization'}: ${scheme}${apiConfig.api_key}'`;
            }

            curlCmd += ` ${url}`;

            const job = queue.addJob({ type: 'ssh', alias: params.server_alias, cmd: curlCmd });
            ssh.executeCommand(job.id);
            const result = await waitForJobCompletion(job.id, config.syncTimeout);

            if (!result || result.status !== 'completed') {
                throw new Error(result ? result.error : `Timeout de la commande de monitoring pour ${params.alias}`);
            }

            const parsedOutput = ssh.parseApiHealth(result.output);
            return { content: [{ type: "text", text: JSON.stringify(parsedOutput, null, 2) }] };
        } catch (e) {
            return { content: [{ type: "text", text: `ERREUR: ${e.message}` }], isError: true };
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
            const cmd = `curl -o /dev/null -s -w '%{http_code}:%{time_total}' ${params.url}`;
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
            } else if (Date.now() - startTime > timeout) {
                clearInterval(interval);
                resolve(null);
            }
        }, 200);
    });
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
            return { content: [{ type: "text", text: `Tâche de transfert ${job.id} initiée en arrière-plan.` }] };
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
            return { content: [{ type: "text", text: `Tâche d'exécution ${job.id} initiée en arrière-plan.` }] };
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
            return { content: [{ type: "text", text: `Tâche de transferts multiples ${job.id} initiée en arrière-plan.` }] };
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
            timeout: z.number().optional().describe("Timeout personnalisé en secondes. Défaut 2 minutes."),
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
            return { content: [{ type: "text", text: `Tâche interactive ${job.id} initiée en arrière-plan.` }] };
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

        const finalJob = await waitForJobCompletion(job.id, config.syncTimeout * params.commands.length);
        if (finalJob) {
            return { content: [{ type: "text", text: `Résultat séquence (tâche ${finalJob.id}):\n${JSON.stringify(finalJob, null, 2)}` }] };
        } else {
            return { content: [{ type: "text", text: `Séquence de commandes ${job.id} initiée en arrière-plan.` }] };
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
            return { content: [{ type: "text", text: `Tâche ${job.id} initiée en arrière-plan.` }] };
        }
    }
);

server.registerTool(
    "get_docker_logs",
    {
        title: "Récupérer les logs Docker",
        description: "Raccourci pour récupérer les logs d'un container Docker.",
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
        cmd += ` ${params.container}`;

        const job = queue.addJob({ type: 'ssh', alias: params.alias, cmd: cmd, streaming: false });
        history.logTask(job);
        ssh.executeCommand(job.id);

        const finalJob = await waitForJobCompletion(job.id, config.syncTimeout);
        if (finalJob) {
            return { content: [{ type: "text", text: `🐳 Logs Docker (${params.container}) - ${finalJob.lineCount || 0} lignes:\n\n${finalJob.output || '(vide)'}` }] };
        } else {
            return { content: [{ type: "text", text: `Tâche ${job.id} initiée en arrière-plan.` }] };
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
        const cmd = `tail -n ${params.lines} ${params.filepath}`;
        const job = queue.addJob({ type: 'ssh', alias: params.alias, cmd: cmd, streaming: false });
        history.logTask(job);
        ssh.executeCommand(job.id);

        const finalJob = await waitForJobCompletion(job.id, config.syncTimeout);
        if (finalJob) {
            return { content: [{ type: "text", text: `📄 Contenu de ${params.filepath} (${finalJob.lineCount || 0} lignes):\n\n${finalJob.output || '(vide)'}` }] };
        } else {
            return { content: [{ type: "text", text: `Tâche ${job.id} initiée en arrière-plan.` }] };
        }
    }
);

// --- DÉMARRAGE DU SERVEUR ---
async function main() {
    console.error("🔌 Connexion du transport stdio...");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("🚀 Serveur connecté et prêt !");
}

main().catch((error) => {
    console.error("Erreur fatale du serveur:", error);
    process.exit(1);
});
