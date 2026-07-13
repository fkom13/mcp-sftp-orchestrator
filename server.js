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
import fileOps from './fileOps.js';
import diffEngine from './diffEngine.js';
import compareEngine from './compareEngine.js';
import shellSessions from './shellSessions.js';
import snapshotManager from './snapshotManager.js';
import diffFormatter from './diffFormatter.js';
import notes from './notes.js';
import guide from './guide.js';
import policies from './policies.js';
import tunnels from './tunnels.js';
import { sourceSchema } from './sourceAdapter.js';

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
    version: "11.3.0",
    description: "Serveur pour l'orchestration de tâches distantes avec exécution hybride et configuration flexible."
});

if (DEBUG) console.error("✅ Serveur MCP créé");

// Restaurer les tunnels locaux au démarrage
tunnels.restore(servers).then(n => {
    if (n > 0) queue.log('info', `${n} tunnels locaux restaurés.`);
}).catch(() => {});

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

// --- OUTILS DE SÉCURITÉ / POLICIES ---

server.registerTool(
    "policy_blocklist_list",
    {
        title: "Lister les commandes bloquées",
        description: "Affiche la liste des patterns de commandes bloquées par la politique de sécurité.",
        inputSchema: z.object({})
    },
    async () => {
        const policiesData = await policies.list();
        return { content: [{ type: "text", text: JSON.stringify(policiesData, null, 2) }] };
    }
);

server.registerTool(
    "policy_blocklist_add",
    {
        title: "Ajouter une commande à la blocklist",
        description: "Ajoute un pattern de commande à la liste noire. Le pattern peut contenir * comme joker.",
        inputSchema: z.object({
            pattern: z.string().describe("Pattern de commande à bloquer (ex: 'rm -rf /' ou 'wget * | sh')")
        })
    },
    async (params) => {
        const policiesData = await policies.add(params.pattern);
        return { content: [{ type: "text", text: `Pattern '${params.pattern}' ajouté à la blocklist.\n` + JSON.stringify(policiesData, null, 2) }] };
    }
);

server.registerTool(
    "policy_blocklist_remove",
    {
        title: "Retirer une commande de la blocklist",
        description: "Supprime un pattern de commande de la liste noire.",
        inputSchema: z.object({
            pattern: z.string().describe("Pattern à retirer de la blocklist")
        })
    },
    async (params) => {
        const policiesData = await policies.remove(params.pattern);
        return { content: [{ type: "text", text: `Pattern '${params.pattern}' retiré de la blocklist.\n` + JSON.stringify(policiesData, null, 2) }] };
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
            const cmd = "echo '---SYSTEMD---' ; systemctl --type=service --state=running --no-pager 2>/dev/null || echo '(systemd indisponible)' ; echo '---DOCKER---' ; if command -v docker &>/dev/null; then docker ps --format '{{.Names}}: {{.Status}}' 2>/dev/null || echo '(Docker arrêté)'; else echo '(Docker non installé)'; fi ; echo '---PM2---' ; if command -v pm2 &>/dev/null; then pm2 list 2>/dev/null || echo '(PM2 arrêté)'; else echo '(PM2 non installé)'; fi";
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
        description: `Lance un transfert SFTP. Si la tâche prend moins de ${config.syncTimeout / 1000}s, le résultat est direct. Sinon, elle passe en arrière-plan. direction 'server_to_server' transfert entre deux serveurs distants (via source_alias → alias).`,
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur cible."),
            direction: z.enum(['upload', 'download', 'server_to_server']),
            local: z.string().optional().describe("Chemin absolu local (upload/download)."),
            remote: z.string().describe("Chemin absolu distant."),
            source_alias: z.string().optional().describe("Alias source (requis si direction='server_to_server')."),
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
        title: "Exécuter une commande à distance (SSH) — multi-serveur supporté",
        description: `Exécute une commande SSH. Si la tâche prend moins de ${config.syncTimeout / 1000}s, le résultat est direct. Sinon, elle passe en arrière-plan. Supporte alias unique ("vps1"), multiple (["vps1","vps2"]) ou "all" pour tout le parc.`,
        inputSchema: z.object({
            alias: z.union([z.string(), z.array(z.string())]).describe("Alias du serveur cible, tableau d'alias, ou 'all' pour tout le parc."),
            cmd: z.string().describe("La commande complète à exécuter."),
            timeout: z.number().optional().describe("Timeout en secondes. 0 = pas de limite. Défaut: 600s (10 min)."),
            skip_policy: z.boolean().optional().default(false).describe("Ignorer la politique de sécurité (blocklist)."),
            rappel: z.number().optional().describe("Définit un rappel en secondes.")
        })
    },
    async (params) => {
        const aliases = Array.isArray(params.alias) ? params.alias
            : params.alias === 'all' ? Object.keys(await servers.listServers())
            : [params.alias];

        if (aliases.length === 1) {
            const job = queue.addJob({ type: 'ssh', alias: aliases[0], cmd: params.cmd, timeout: params.timeout, skip_policy: params.skip_policy, status: 'pending' });
            history.logTask(job);
            ssh.executeCommand(job.id);
            const finalJob = await waitForJobCompletion(job.id, config.syncTimeout);
            if (finalJob) {
                return { content: [{ type: "text", text: `Résultat direct (tâche ${finalJob.id}):\n${finalJob.output || JSON.stringify(finalJob, null, 2)}` }] };
            } else {
                return { content: [{ type: "text", text: buildAsyncMessage(job, "d'exécution") }] };
            }
        }

        const jobs = aliases.map(alias =>
            queue.addJob({ type: 'ssh', alias, cmd: params.cmd, timeout: params.timeout, skip_policy: params.skip_policy, status: 'pending' })
        );
        jobs.forEach(j => { history.logTask(j); ssh.executeCommand(j.id); });

        const results = await Promise.all(jobs.map(j => waitForJobCompletion(j.id, config.syncTimeout)));
        const output = results.map((r, i) => {
            if (!r) return `[${aliases[i]}] Timeout ou erreur`;
            if (r.status === 'failed') return `[${aliases[i]}] ERREUR: ${r.error}`;
            return `[${aliases[i]}] OK\n${r.output || '(vide)'}`;
        }).join('\n\n---\n\n');

        return { content: [{ type: "text", text: `Résultats multi-serveur (${aliases.length} cibles):\n\n${output}` }] };
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
        // Schémas des paramètres pour les outils clés
        const TOOL_SCHEMAS = {
            policy_blocklist_list: `Paramètres: aucun`,

            policy_blocklist_add: `Paramètres:
  pattern (string, requis) — Pattern de commande à bloquer (ex: "rm -rf /" ou "wget * | sh")`,

            policy_blocklist_remove: `Paramètres:
  pattern (string, requis) — Pattern à retirer de la blocklist`,

            tmux_create: `Paramètres:
  alias     (string, requis)    — Serveur cible
  name      (string, opt)       — Nom de session (auto-généré si omis)
  start_cmd (string, opt)       — Commande initiale à lancer`,

            tmux_exec: `Paramètres:
  alias   (string, requis)  — Serveur cible
  session (string, requis)  — Nom de la session tmux
  cmd     (string, requis)  — Commande à exécuter`,

            tmux_read: `Paramètres:
  alias   (string, requis)  — Serveur cible
  session (string, requis)  — Nom de la session`,

            tmux_list: `Paramètres:
  alias (string, requis) — Serveur cible`,

            tmux_kill: `Paramètres:
  alias   (string, requis)  — Serveur cible
  session (string, requis)  — Nom de la session à tuer`,

            server_add: `Paramètres:
  alias     (string, requis)     — Nom unique du serveur (ex: vps_production)
  host      (string, requis)     — IP ou nom d'hôte
  user      (string, requis)     — Utilisateur SSH
  keyPath   (string, optionnel)  — Chemin absolu vers clé privée SSH
  password  (string, optionnel)  — Mot de passe SSH
→ Fournir keyPath OU password (au moins un des deux).`,

            api_add: `Paramètres:
  alias               (string, requis)    — Nom unique
  url                 (string, requis)    — URL de base (ex: https://api.example.com)
  health_check_endpoint (string, opt)     — Path de health (défaut: /)
  health_check_method (GET|POST, opt)     — Méthode HTTP (défaut: GET)
  auth_method         (none|api_key|htpasswd|both, opt)
  api_key             (string, opt)       — Clé API
  auth_header_name    (string, opt)       — Header pour la clé (défaut: Authorization)
  auth_scheme         (string, opt)       — Schéma d'auth (défaut: Bearer)
  htpasswd_user       (string, opt)       — Utilisateur Basic Auth
  htpasswd_pass       (string, opt)       — Mot de passe Basic Auth
  notes               (string, opt)       — Notes`,

            task_exec: `Paramètres:
  alias      (string|string[], requis) — Alias, tableau d'alias, ou "all"
  cmd        (string, requis)          — Commande à exécuter
  timeout    (number, opt)             — Timeout en secondes (0=infini, défaut: 600)
  skip_policy (bool, opt)              — Ignorer la blocklist (défaut: false)
  rappel     (number, opt)             — Rappel en secondes`,

            file_read: `Paramètres:
  source   (object, requis)  — {type:'local'|'remote', path, alias?, label?}
  encoding (utf8|base64, opt) — Défaut: utf8
  offset   (int, opt)        — Ligne de départ (1-indexée)
  limit    (int, opt)        — Nombre de lignes`,

            file_edit: `Paramètres:
  source       (object, requis) — {type, path, alias?, label?}
  oldString    (string, opt*)   — Texte à remplacer (mode chirurgical)
  newString    (string, opt*)   — Texte de remplacement
  replaceAll   (bool, opt)      — Remplacer toutes les occurrences
  newContent   (string, opt*)   — Contenu complet (mode complet)
  expectedHash (string, opt)    — Hash SHA-256 (anti-écrasement)
  dryRun       (bool, opt)      — Prévisualiser sans écrire
  backup       (bool, opt)      — Snapshot avant modif
→ (*) Soit oldString+newString, soit newContent.`,

            file_write: `Paramètres:
  source     (object, requis) — {type, path, alias?, label?}
  content    (string, requis) — Contenu à écrire
  encoding   (utf8|base64, opt) — Défaut: utf8
  createDirs (bool, opt)      — Créer les dossiers parents
  dryRun     (bool, opt)      — Prévisualiser sans écrire
  backup     (bool, opt)      — Snapshot avant écrasement`,

            task_transfer: `Paramètres:
  alias     (string, requis)     — Serveur cible
  direction (upload|download, requis)
  local     (string, requis)     — Chemin local absolu
  remote    (string, requis)     — Chemin distant absolu
  force     (bool, opt)          — Écraser sans confirmation
  rappel    (number, opt)        — Rappel en secondes`,

            snapshot_create: `Paramètres:
  source    (object, requis)  — {type:'local'|'remote', alias?}
  paths     (string[], req)   — Chemins à capturer
  tag       (string, opt)     — Étiquette (ex: 'before-fix')
  message   (string, opt)     — Description
  recursive (bool, opt)       — Parcours récursif (défaut: true)
  ignorePatterns (string[], opt) — Motifs glob à exclure`,

            diff_files: `Paramètres:
  source1  (object, requis) — {type, path, alias?, label?}
  source2  (object, requis) — {type, path, alias?, label?}`,

            compare_all_sources: `Paramètres:
  sources       (object[], requis) — [{type, path, alias?, label?}, ...] (min 2)
  includeContent (bool, opt)       — Inclure le contenu complet
  includeDiff    (bool, opt)       — Générer le diff (défaut: true)`,

            tunnel_create: `Paramètres:
  name        (string, requis)     — Nom unique (ex: 'crm-dev')
  type        (local|remote|socks) — Type de tunnel
  listen_port (number, requis)     — Port d'écoute (ex: 8080)
  target      (string, opt)        — Cible host:port, requis pour local/remote
  via         (string, requis)     — Alias du serveur de transit SSH
  source      (string, opt)        — null=local, ou alias serveur`,

            tunnel_list: `Paramètres: aucun`,

            tunnel_close: `Paramètres:
  name (string, requis) — Nom du tunnel à fermer`,

            tunnel_allowlist_add: `Paramètres:
  port (number, requis) — Port à autoriser`,

            tunnel_allowlist_remove: `Paramètres:
  port (number, requis) — Port à retirer`
        };

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
            { name: "task_transfer", desc: "Transfert SFTP fichier/dossier. server_to_server: transfert direct entre deux serveurs distants." },
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
            { name: "tail_file", desc: "Afficher les dernières lignes d'un fichier distant." },
            { name: "file_read", desc: "Lire un fichier (local ou remote) + hash SHA-256. source:{type,path,alias?}." },
            { name: "file_write", desc: "Créer/écraser un fichier (local ou remote). dryRun (preview) + backup (snapshot avant écrasement)." },
            { name: "file_edit", desc: "Éditer chirurgical (oldString/newString) ou complet (newContent). dryRun + backup + protection hash." },
            { name: "diff_files", desc: "Comparer 2 fichiers (local/remote, cross-server). Diff unifié + origine des sources." },
            { name: "diff_folders", desc: "Comparer 2 dossiers : fichiers ajoutés/supprimés/modifiés. ignorePatterns supporté." },
            { name: "compare_all_sources", desc: "Comparer un fichier sur N sources (parc). Regroupe par hash, détecte les drifts." },
            { name: "shell_create", desc: "Ouvrir une session shell persistante (cd/export persistent) sur un serveur distant." },
            { name: "shell_exec", desc: "Exécuter une commande dans une session shell persistante (état conservé)." },
            { name: "shell_list", desc: "Lister les sessions shell actives (alias, âge, commandes, état)." },
            { name: "shell_close", desc: "Fermer proprement une session shell persistante." },
            { name: "snapshot_create", desc: "Capturer l'état de fichiers/dossiers (local/remote) avec déduplication." },
            { name: "snapshot_list", desc: "Lister les snapshots d'infrastructure (filtrable par source/tag)." },
            { name: "snapshot_diff", desc: "Comparer 2 snapshots (même cross local↔remote). Détection de drift." },
            { name: "snapshot_restore", desc: "Restaurer un snapshot (dryRun par défaut, force requis pour écraser)." },
            { name: "snapshot_delete", desc: "Supprimer un snapshot + nettoyer les blobs orphelins." },
            { name: "guide", desc: "Manuel IA : workflows, cheatsheet, pièges (section:index/workflows/...)." },
            { name: "server_note_set", desc: "Définir le contexte d'un serveur (description, services, warnings, conventions)." },
            { name: "server_note_get", desc: "Lire le contexte/protocole d'un serveur (à consulter avant d'intervenir)." },
            { name: "server_note_list", desc: "Vue d'ensemble des notes de tout le parc." },
            { name: "server_note_remove", desc: "Supprimer la note d'un serveur." },
            { name: "infra_overview", desc: "Vue synthétique du parc : serveurs + notes (rôle, services, warnings)." },
            { name: "policy_blocklist_list", desc: "Lister les commandes bloquées par la politique de sécurité." },
            { name: "policy_blocklist_add", desc: "Ajouter un pattern à la blocklist." },
            { name: "policy_blocklist_remove", desc: "Retirer un pattern de la blocklist." },
            { name: "tmux_create", desc: "Créer une session tmux persistante sur un serveur." },
            { name: "tmux_exec", desc: "Envoyer une commande dans une session tmux." },
            { name: "tmux_read", desc: "Lire le buffer d'une session tmux." },
            { name: "tmux_list", desc: "Lister les sessions tmux actives." },
            { name: "tmux_kill", desc: "Tuer une session tmux." },
            { name: "tunnel_create", desc: "Créer un tunnel SSH (local/remote/socks)." },
            { name: "tunnel_list", desc: "Lister les tunnels actifs." },
            { name: "tunnel_close", desc: "Fermer un tunnel." },
            { name: "tunnel_allowlist_add", desc: "Ajouter un port à l'allowlist." },
            { name: "tunnel_allowlist_remove", desc: "Retirer un port de l'allowlist." }
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
            const schema = TOOL_SCHEMAS[params.tool];
            let detail = `Outil: ${tool.name}\nDescription: ${tool.desc}`;
            if (schema) detail += `\n\n${schema}`;
            detail += `\n\nAstuce: guide section:audit pour l'audit complet du parc.`;
            return { content: [{ type: "text", text: detail }] };
        }

        const guide = `=== GUIDE MCP ORCHESTRATOR v11.3.0 ===

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

// --- OPÉRATIONS FICHIERS (LOCAL + REMOTE) ---

// Résout la config serveur si remote, et valide la cohérence type/alias
function resolveSource(source) {
    if (source.type === 'remote' && !source.alias) {
        throw new Error("Source remote invalide : 'alias' est requis quand type='remote'.");
    }
    return source; // sourceAdapter récupère la config via serverManager.getServer(alias)
}

server.registerTool(
    "file_read",
    {
        title: "Lire un fichier (local ou distant)",
        description: "Lit un fichier et retourne son contenu + hash SHA-256 (pour édition sécurisée). Supporte localhost (sans SSH) et remote (SFTP). encoding 'base64' pour les binaires. offset/limit (par lignes, utf8) pour consulter un gros fichier sans tout charger — le hash reste celui du fichier complet (edit-safe).",
        inputSchema: z.object({
            source: sourceSchema,
            encoding: z.enum(['utf8', 'base64']).optional().default('utf8'),
            offset: z.number().int().positive().optional().describe("Ligne de départ (1-indexée) pour lecture partielle"),
            limit: z.number().int().positive().optional().describe("Nombre de lignes à retourner (lecture partielle)")
        })
    },
    async (params) => {
        try {
            const source = resolveSource(params.source);
            const result = await fileOps.readFile(source, params.encoding, {
                offset: params.offset,
                limit: params.limit
            });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
            const errorPayload = { toolName: "file_read", errorCode: "READ_ERROR", errorMessage: e.message };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "file_write",
    {
        title: "Écrire un fichier (local ou distant)",
        description: "Crée ou écrase un fichier. Crée les dossiers parents si besoin. Supporte localhost (sans SSH) et remote (SFTP). dryRun:true pour prévisualiser le diff sans écrire. backup:true pour snapshotter l'ancien fichier avant écrasement (undo via snapshot_restore). Pour modifier un fichier existant, préférez file_edit (édition chirurgicale).",
        inputSchema: z.object({
            source: sourceSchema,
            content: z.string().describe("Contenu à écrire"),
            encoding: z.enum(['utf8', 'base64']).optional().default('utf8'),
            createDirs: z.boolean().optional().default(true),
            dryRun: z.boolean().optional().default(false).describe("Prévisualiser le diff sans écrire"),
            backup: z.boolean().optional().default(false).describe("Snapshot du fichier existant avant écrasement (filet de sécurité)")
        })
    },
    async (params) => {
        try {
            const source = resolveSource(params.source);
            const result = await fileOps.writeFile(source, params.content, params.encoding, {
                createDirs: params.createDirs,
                dryRun: params.dryRun,
                backup: params.backup
            });
            // Affichage client : si un diff est présent (dryRun), le rendre en markdown lisible
            if (result.diff && result.diff !== '(binaire — diff non affiché)') {
                const title = result.dryRun ? `Prévisualisation écriture — ${result.origin.label}` : result.origin.label;
                const fmt = diffFormatter.format(result.diff, { title });
                return diffFormatter.response(fmt.markdown, result);
            }
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
            const errorPayload = { toolName: "file_write", errorCode: "WRITE_ERROR", errorMessage: e.message };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "file_edit",
    {
        title: "Éditer un fichier (local ou distant) — chirurgical ou complet",
        description: "Édite un fichier. DEUX MODES : (A) chirurgical via oldString/newString (remplace un bout précis, économe en tokens) ; (B) complet via newContent (remplace tout). Protection expectedHash optionnelle (anti-écrasement concurrent). dryRun:true = prévisualiser le diff sans écrire. backup:true = snapshot avant modif (undo via snapshot_restore). Workflow recommandé: file_read → file_edit avec oldString/newString + expectedHash.",
        inputSchema: z.object({
            source: sourceSchema,
            oldString: z.string().optional().describe("Mode chirurgical : texte exact à remplacer (avec indentation/espaces)"),
            newString: z.string().optional().describe("Mode chirurgical : texte de remplacement"),
            replaceAll: z.boolean().optional().default(false).describe("Mode chirurgical : remplacer toutes les occurrences (sinon erreur si multiples)"),
            newContent: z.string().optional().describe("Mode complet : nouveau contenu intégral du fichier"),
            expectedHash: z.string().optional().describe("Hash SHA-256 obtenu via file_read (protection anti-écrasement, recommandé)"),
            encoding: z.enum(['utf8', 'base64']).optional().default('utf8'),
            dryRun: z.boolean().optional().default(false).describe("Prévisualiser le diff sans écrire"),
            backup: z.boolean().optional().default(false).describe("Snapshot du fichier avant modification (filet de sécurité)")
        })
    },
    async (params) => {
        try {
            const source = resolveSource(params.source);
            const result = await fileOps.editFile(source, {
                oldString: params.oldString,
                newString: params.newString,
                replaceAll: params.replaceAll,
                newContent: params.newContent,
                expectedHash: params.expectedHash,
                encoding: params.encoding,
                dryRun: params.dryRun,
                backup: params.backup
            });
            // Affichage client : diff rendu en markdown lisible (```diff coloré)
            if (result.diff) {
                const title = result.dryRun
                    ? `Prévisualisation édition — ${result.origin.label}`
                    : `Édition appliquée — ${result.origin.label}`;
                const fmt = diffFormatter.format(result.diff, { title });
                return diffFormatter.response(fmt.markdown, result);
            }
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
            if (e.code === 'HASH_MISMATCH') {
                const errorPayload = {
                    toolName: "file_edit",
                    errorCode: "HASH_MISMATCH",
                    errorMessage: e.message,
                    currentHash: e.current?.hash,
                    currentContent: e.current?.content
                };
                return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
            }
            if (e.code === 'OLDSTRING_NOT_FOUND' || e.code === 'MULTIPLE_MATCHES') {
                const errorPayload = {
                    toolName: "file_edit",
                    errorCode: e.code,
                    errorMessage: e.message,
                    ...(e.occurrences ? { occurrences: e.occurrences } : {})
                };
                return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
            }
            const errorPayload = { toolName: "file_edit", errorCode: "EDIT_ERROR", errorMessage: e.message };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

// --- COMPARAISON / DIFF (LOCAL + REMOTE, CROSS-SERVER) ---

server.registerTool(
    "diff_files",
    {
        title: "Comparer deux fichiers (local/remote, cross-server)",
        description: "Génère un diff unifié entre deux fichiers. N'importe quelle combinaison : local↔local, local↔remote, remote↔remote. Indique l'origine (serveur+chemin) de chaque source. Retourne identical:true si contenus identiques.",
        inputSchema: z.object({
            source1: sourceSchema,
            source2: sourceSchema
        })
    },
    async (params) => {
        try {
            const s1 = resolveSource(params.source1);
            const s2 = resolveSource(params.source2);
            const result = await diffEngine.diffFiles(s1, s2);
            // Affichage client : diff en markdown si les fichiers diffèrent
            if (!result.identical && result.diff) {
                const title = `${result.source1.label} → ${result.source2.label}`;
                const fmt = diffFormatter.format(result.diff, { title });
                return diffFormatter.response(fmt.markdown, result);
            }
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
            const errorPayload = { toolName: "diff_files", errorCode: "DIFF_ERROR", errorMessage: e.message };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "diff_folders",
    {
        title: "Comparer deux dossiers (local/remote, cross-server)",
        description: "Compare les arborescences de deux dossiers. Retourne les fichiers présents uniquement d'un côté, identiques, et modifiés (avec compteur +/- lignes). includeDiff:true pour le diff détaillé de chaque fichier modifié. ignorePatterns pour exclure (ex: ['node_modules','*.log']).",
        inputSchema: z.object({
            source1: sourceSchema,
            source2: sourceSchema,
            recursive: z.boolean().optional().default(true),
            compareContent: z.boolean().optional().default(true),
            includeDiff: z.boolean().optional().default(false).describe("Inclure le diff unifié complet pour chaque fichier modifié"),
            ignorePatterns: z.array(z.string()).optional().describe("Motifs glob à ignorer (ex: ['node_modules', '*.log', '.git'])")
        })
    },
    async (params) => {
        try {
            const s1 = resolveSource(params.source1);
            const s2 = resolveSource(params.source2);
            const result = await diffEngine.diffFolders(s1, s2, {
                recursive: params.recursive,
                compareContent: params.compareContent,
                includeDiff: params.includeDiff,
                ignorePatterns: params.ignorePatterns
            });
            // Affichage client : résumé lisible des fichiers (modifiés/ajoutés/supprimés)
            const hasChanges = result.modified.length || result.only_in_source1.length || result.only_in_source2.length;
            if (hasChanges) {
                const md = diffFormatter.formatFileList({
                    modified: result.modified,
                    added: result.only_in_source2,   // présents côté source2 uniquement
                    removed: result.only_in_source1  // présents côté source1 uniquement
                }, { title: `${result.source1.label} → ${result.source2.label}` });
                return { content: [{ type: "text", text: md }, { type: "text", text: JSON.stringify(result, null, 2) }] };
            }
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
            const errorPayload = { toolName: "diff_folders", errorCode: "DIFF_ERROR", errorMessage: e.message };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "compare_all_sources",
    {
        title: "Comparer un fichier sur plusieurs sources (détection drift)",
        description: "Compare un fichier sur plusieurs sources (localhost + serveurs distants). Regroupe par hash : plus d'un groupe = drift. Chaque source peut avoir un chemin DIFFÉRENT (ex: .bashrc sur un VPS, .zshrc sur un autre) et un 'label' personnalisé pour un affichage clair. Le groupe majoritaire sert de référence ; includeDiff (défaut true) génère le diff réel référence→divergences.",
        inputSchema: z.object({
            sources: z.array(sourceSchema).min(2).describe("Liste de sources à comparer (2+, local et/ou remote). Chaque source peut avoir path différent + label."),
            includeContent: z.boolean().optional().default(false).describe("Inclure le contenu complet de chaque version distincte"),
            includeDiff: z.boolean().optional().default(true).describe("Générer le diff réel entre la référence (groupe majoritaire) et chaque version divergente")
        })
    },
    async (params) => {
        try {
            const sources = params.sources.map(resolveSource);
            const result = await compareEngine.compareSources(sources, {
                includeContent: params.includeContent,
                includeDiff: params.includeDiff
            });
            // Affichage client : si drift, rendre le(s) diff(s) référence→divergence en markdown
            if (result.drift && result.drifts && result.drifts.length > 0) {
                const parts = [`### ⚠️ Drift détecté — ${result.stats.uniqueVersions} versions sur ${result.stats.totalSources} sources`];
                parts.push(`Référence : \`${result.reference.label}\` (${result.reference.sources.length} source(s))\n`);
                for (const d of result.drifts) {
                    if (d.diff) {
                        const fmt = diffFormatter.format(d.diff, { title: `${d.from} → ${d.to}` });
                        parts.push(fmt.markdown);
                    }
                }
                return { content: [{ type: "text", text: parts.join('\n\n') }, { type: "text", text: JSON.stringify(result, null, 2) }] };
            }
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
            const errorPayload = { toolName: "compare_all_sources", errorCode: "COMPARE_ERROR", errorMessage: e.message };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

// --- SESSIONS SHELL PERSISTANTES (remote) ---

server.registerTool(
    "shell_create",
    {
        title: "Créer une session shell persistante",
        description: "Ouvre un shell PTY persistant sur un serveur distant où cd, export, activations d'env PERSISTENT entre les commandes (contrairement à task_exec qui isole chaque commande). Retourne un sessionId à utiliser avec shell_exec. Fermer avec shell_close quand terminé.",
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur cible"),
            workdir: z.string().optional().describe("Répertoire de démarrage (cd initial)"),
            env: z.record(z.string()).optional().describe("Variables d'environnement initiales {CLE: valeur}"),
            cmdTimeout: z.number().optional().describe("Timeout par défaut des commandes en secondes (défaut 300, 0=infini)")
        })
    },
    async (params) => {
        try {
            const result = await shellSessions.createSession(params.alias, {
                workdir: params.workdir,
                env: params.env,
                cmdTimeout: params.cmdTimeout
            });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
            const errorPayload = { toolName: "shell_create", errorCode: "SHELL_CREATE_ERROR", errorMessage: e.message };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "shell_exec",
    {
        title: "Exécuter dans une session shell persistante",
        description: "Exécute une commande dans une session shell existante (créée via shell_create). L'état (répertoire courant, variables) PERSISTE entre les appels. Retourne { output, exitCode, timedOut }. Une seule commande à la fois par session.",
        inputSchema: z.object({
            sessionId: z.string().describe("ID de session obtenu via shell_create"),
            command: z.string().describe("Commande à exécuter"),
            timeout: z.number().optional().describe("Timeout en secondes pour cette commande (0=infini)")
        })
    },
    async (params) => {
        try {
            const result = await shellSessions.execInSession(params.sessionId, params.command, params.timeout);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
            const errorPayload = { toolName: "shell_exec", errorCode: "SHELL_EXEC_ERROR", errorMessage: e.message };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "shell_list",
    {
        title: "Lister les sessions shell actives",
        description: "Affiche toutes les sessions shell persistantes en cours avec leur état (alias, âge, inactivité, nombre de commandes, occupée/fermée).",
        inputSchema: z.object({})
    },
    async () => {
        try {
            const sessions = shellSessions.listSessions();
            return { content: [{ type: "text", text: JSON.stringify({ sessions, count: sessions.length }, null, 2) }] };
        } catch (e) {
            const errorPayload = { toolName: "shell_list", errorCode: "SHELL_LIST_ERROR", errorMessage: e.message };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "shell_close",
    {
        title: "Fermer une session shell persistante",
        description: "Termine proprement une session shell (ferme le shell et la connexion SSH dédiée). À faire quand la session n'est plus nécessaire. Les sessions inactives sont aussi fermées automatiquement après 30 min.",
        inputSchema: z.object({
            sessionId: z.string().describe("ID de session à fermer")
        })
    },
    async (params) => {
        try {
            const result = shellSessions.closeSession(params.sessionId);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
            const errorPayload = { toolName: "shell_close", errorCode: "SHELL_CLOSE_ERROR", errorMessage: e.message };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

// --- SNAPSHOTS D'INFRASTRUCTURE (local + remote, versioning + dedup) ---

server.registerTool(
    "snapshot_create",
    {
        title: "Créer un snapshot d'infrastructure",
        description: "Capture l'état de fichiers/dossiers critiques (localhost sans SSH, ou serveur distant via SFTP). Déduplication automatique par contenu (hash). Idéal avant une modification risquée. Retourne un snapshotId.",
        inputSchema: z.object({
            source: z.object({
                type: z.enum(['local', 'remote']),
                alias: z.string().optional().describe("Requis si type='remote'")
            }),
            paths: z.array(z.string()).min(1).describe("Chemins absolus à capturer (fichiers ou dossiers)"),
            tag: z.string().optional().describe("Étiquette (ex: 'before-nginx-fix')"),
            message: z.string().optional(),
            recursive: z.boolean().optional().default(true),
            ignorePatterns: z.array(z.string()).optional().describe("Motifs glob à exclure (ex: ['node_modules','*.log'])")
        })
    },
    async (params) => {
        try {
            if (params.source.type === 'remote' && !params.source.alias) {
                throw new Error("alias requis quand type='remote'.");
            }
            const result = await snapshotManager.createSnapshot(params.source, params.paths, {
                tag: params.tag,
                message: params.message,
                recursive: params.recursive,
                ignorePatterns: params.ignorePatterns
            });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
            const errorPayload = { toolName: "snapshot_create", errorCode: "SNAPSHOT_ERROR", errorMessage: e.message };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "snapshot_list",
    {
        title: "Lister les snapshots d'infrastructure",
        description: "Affiche les snapshots filtrés par source (localhost, serveur, tag). Résumé léger (id, serveur, tag, date, nb fichiers).",
        inputSchema: z.object({
            sourceType: z.enum(['local', 'remote']).optional(),
            sourceAlias: z.string().optional(),
            tag: z.string().optional(),
            limit: z.number().optional().default(20)
        })
    },
    async (params) => {
        try {
            const result = await snapshotManager.listSnapshots({
                sourceType: params.sourceType,
                sourceAlias: params.sourceAlias,
                tag: params.tag,
                limit: params.limit
            });
            return { content: [{ type: "text", text: JSON.stringify({ snapshots: result, count: result.length }, null, 2) }] };
        } catch (e) {
            const errorPayload = { toolName: "snapshot_list", errorCode: "LIST_ERROR", errorMessage: e.message };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "snapshot_diff",
    {
        title: "Comparer deux snapshots",
        description: "Diff entre deux snapshots (par chemin). Fonctionne même entre un snapshot local et un snapshot remote (détection de drift local↔prod). includeDiff:true pour le détail ligne à ligne.",
        inputSchema: z.object({
            snapshot1: z.string().describe("ID ou tag du premier snapshot"),
            snapshot2: z.string().describe("ID ou tag du second snapshot"),
            includeDiff: z.boolean().optional().default(false)
        })
    },
    async (params) => {
        try {
            const result = await snapshotManager.diffSnapshots(params.snapshot1, params.snapshot2, {
                includeDiff: params.includeDiff
            });
            // Affichage client : résumé lisible des fichiers changés entre snapshots
            const hasChanges = result.modified.length || result.added.length || result.removed.length;
            if (hasChanges) {
                let md = diffFormatter.formatFileList({
                    modified: result.modified,
                    added: result.added,
                    removed: result.removed
                }, { title: `${result.snapshot1.id} → ${result.snapshot2.id}` });
                // Si includeDiff, ajoute les diffs détaillés des fichiers modifiés
                if (params.includeDiff) {
                    for (const m of result.modified) {
                        if (m.diff) md += '\n\n' + diffFormatter.format(m.diff, { title: m.path }).markdown;
                    }
                }
                return { content: [{ type: "text", text: md }, { type: "text", text: JSON.stringify(result, null, 2) }] };
            }
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
            const errorPayload = { toolName: "snapshot_diff", errorCode: "DIFF_ERROR", errorMessage: e.message };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "snapshot_restore",
    {
        title: "Restaurer un snapshot",
        description: "Restaure les fichiers d'un snapshot vers une cible (local ou remote). DANGEREUX : dryRun:true par défaut (prévisualisation). Restauration réelle exige dryRun:false ET force:true. Peut restaurer un snapshot remote vers local (backup) et inversement (déploiement).",
        inputSchema: z.object({
            snapshotId: z.string().describe("ID ou tag du snapshot"),
            target: z.object({
                type: z.enum(['local', 'remote']),
                alias: z.string().optional().describe("Requis si type='remote'")
            }),
            paths: z.array(z.string()).optional().describe("Restaurer uniquement ces chemins (préfixes)"),
            dryRun: z.boolean().optional().default(true),
            force: z.boolean().optional().default(false)
        })
    },
    async (params) => {
        try {
            if (params.target.type === 'remote' && !params.target.alias) {
                throw new Error("alias requis quand type='remote'.");
            }
            // Sécurité : restauration réelle bloquée sans force explicite
            if (!params.dryRun && !params.force) {
                const errorPayload = {
                    toolName: "snapshot_restore",
                    errorCode: "CONFIRMATION_REQUIRED",
                    errorMessage: "Restauration réelle bloquée. Faites d'abord un dryRun:true pour prévisualiser, puis dryRun:false + force:true pour confirmer.",
                    hint: "Toujours valider avec l'utilisateur avant force:true (écrasement de fichiers)."
                };
                return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
            }
            const result = await snapshotManager.restoreSnapshot(params.snapshotId, params.target, {
                paths: params.paths,
                dryRun: params.dryRun,
                force: params.force
            });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
            const errorPayload = { toolName: "snapshot_restore", errorCode: "RESTORE_ERROR", errorMessage: e.message };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "snapshot_delete",
    {
        title: "Supprimer un snapshot",
        description: "Supprime un snapshot et nettoie les blobs devenus orphelins (dedup-aware : ne supprime que les contenus plus référencés). Retourne l'espace libéré.",
        inputSchema: z.object({
            snapshotId: z.string().describe("ID ou tag du snapshot à supprimer")
        })
    },
    async (params) => {
        try {
            const result = await snapshotManager.deleteSnapshot(params.snapshotId);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
            const errorPayload = { toolName: "snapshot_delete", errorCode: "DELETE_ERROR", errorMessage: e.message };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

// --- NOTES / PROTOCOLE PAR SERVEUR (mémoire contextuelle du parc) ---

server.registerTool(
    "server_note_set",
    {
        title: "Définir la note/protocole d'un serveur",
        description: "Attache un contexte à un serveur pour ne pas se perdre dans le parc : description, services critiques, avertissements, conventions, note libre. Merge partiel (seuls les champs fournis sont modifiés). 'intervention' met à jour automatiquement last_intervention.",
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur"),
            description: z.string().optional().describe("Rôle du serveur"),
            services: z.array(z.string()).optional().describe("Services critiques (ex: ['nginx','pm2:proxy-gw'])"),
            warnings: z.array(z.string()).optional().describe("Avertissements (ex: ['RAM 1Go','ne pas rebuild en prod'])"),
            conventions: z.array(z.string()).optional().describe("Conventions/chemins (ex: ['configs dans /etc/nginx'])"),
            note: z.string().optional().describe("Note libre"),
            intervention: z.string().optional().describe("Résumé de la dernière intervention (horodatée automatiquement)")
        })
    },
    async (params) => {
        try {
            const { alias, ...fields } = params;
            const result = await notes.set(alias, fields);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
            const errorPayload = { toolName: "server_note_set", errorCode: "NOTE_ERROR", errorMessage: e.message };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "server_note_get",
    {
        title: "Lire la note/protocole d'un serveur",
        description: "Récupère le contexte enregistré d'un serveur (description, services, warnings, conventions, dernière intervention). À consulter avant d'intervenir sur un serveur.",
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur")
        })
    },
    async (params) => {
        try {
            const note = await notes.get(params.alias);
            if (!note) {
                return { content: [{ type: "text", text: JSON.stringify({ alias: params.alias, note: null, hint: "Aucune note. Utilisez server_note_set pour en créer une." }, null, 2) }] };
            }
            return { content: [{ type: "text", text: JSON.stringify({ alias: params.alias, ...note }, null, 2) }] };
        } catch (e) {
            const errorPayload = { toolName: "server_note_get", errorCode: "NOTE_ERROR", errorMessage: e.message };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "server_note_list",
    {
        title: "Lister toutes les notes de serveurs",
        description: "Vue d'ensemble des notes/protocoles de tout le parc.",
        inputSchema: z.object({})
    },
    async () => {
        try {
            const all = await notes.list();
            return { content: [{ type: "text", text: JSON.stringify({ notes: all, count: Object.keys(all).length }, null, 2) }] };
        } catch (e) {
            const errorPayload = { toolName: "server_note_list", errorCode: "NOTE_ERROR", errorMessage: e.message };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "server_note_remove",
    {
        title: "Supprimer la note d'un serveur",
        description: "Supprime le contexte enregistré d'un serveur.",
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur")
        })
    },
    async (params) => {
        try {
            const result = await notes.remove(params.alias);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
            const errorPayload = { toolName: "server_note_remove", errorCode: "NOTE_ERROR", errorMessage: e.message };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

// --- VUE SYNTHÉTIQUE DU PARC ---

server.registerTool(
    "infra_overview",
    {
        title: "Vue synthétique du parc",
        description: "Vue d'ensemble en un appel : liste des serveurs configurés + leurs notes (rôle, services, avertissements). Idéal en début de session pour situer le contexte sans se perdre.",
        inputSchema: z.object({})
    },
    async () => {
        try {
            const serverList = await servers.listServers();
            const allNotes = await notes.list();
            const overview = Object.entries(serverList).map(([alias, cfg]) => {
                const n = allNotes[alias] || {};
                return {
                    alias,
                    host: cfg.host,
                    user: cfg.user,
                    description: n.description || null,
                    services: n.services || [],
                    warnings: n.warnings || [],
                    lastIntervention: n.last_intervention || null
                };
            });
            return { content: [{ type: "text", text: JSON.stringify({ servers: overview, count: overview.length }, null, 2) }] };
        } catch (e) {
            const errorPayload = { toolName: "infra_overview", errorCode: "OVERVIEW_ERROR", errorMessage: e.message };
            return { content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }], isError: true };
        }
    }
);

// --- OUTILS TMUX (sessions terminal persistantes) ---

// Helper: vérifie si tmux est installé sur le serveur, retourne un message si absent
async function checkTmux(alias) {
    const job = queue.addJob({ type: 'ssh', alias, cmd: "command -v tmux 2>/dev/null", streaming: false, status: 'pending' });
    ssh.executeCommand(job.id);
    const result = await waitForJobCompletion(job.id, config.syncTimeout);
    if (!result || result.status === 'failed' || !result.output || result.output.trim() === '') {
        return { installed: false, message: `❌ tmux n'est pas installé sur '${alias}'. Pour l'installer: ssh ${alias} "sudo apt install -y tmux"` };
    }
    return { installed: true };
}

server.registerTool(
    "tmux_create",
    {
        title: "Créer une session tmux",
        description: "Crée une nouvelle session tmux sur un serveur distant. La session survit aux déconnexions et aux redémarrages du MCP.",
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur cible."),
            name: z.string().optional().describe("Nom de la session tmux (auto-généré si omis)."),
            start_cmd: z.string().optional().describe("Commande initiale à lancer dans la session.")
        })
    },
    async (params) => {
        const tmuxCheck = await checkTmux(params.alias);
        if (!tmuxCheck.installed) return { content: [{ type: "text", text: tmuxCheck.message }] };
        const sessionName = params.name || `tmux-${Date.now()}`;
        const startCmd = params.start_cmd ? `tmux send-keys -t ${sessionName} '${params.start_cmd}' Enter` : '';
        const cmd = `tmux new-session -d -s ${sessionName} ${startCmd.length > 0 ? '&& ' + startCmd : ''}`;
        const job = queue.addJob({ type: 'ssh', alias: params.alias, cmd, streaming: false, status: 'pending' });
        history.logTask(job);
        ssh.executeCommand(job.id);
        const finalJob = await waitForJobCompletion(job.id, config.syncTimeout);
        const output = finalJob ? finalJob.output || '' : 'Timeout';
        return { content: [{ type: "text", text: output.includes('error') ? `Erreur: ${output}` : `Session tmux '${sessionName}' créée sur ${params.alias}.` }] };
    }
);

server.registerTool(
    "tmux_exec",
    {
        title: "Exécuter une commande dans une session tmux",
        description: "Envoie une commande à une session tmux existante.",
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur."),
            session: z.string().describe("Nom de la session tmux."),
            cmd: z.string().describe("Commande à exécuter dans la session.")
        })
    },
    async (params) => {
        const tmuxCheck = await checkTmux(params.alias);
        if (!tmuxCheck.installed) return { content: [{ type: "text", text: tmuxCheck.message }] };
        const cmd = `tmux send-keys -t ${params.session} '${params.cmd}' Enter`;
        const job = queue.addJob({ type: 'ssh', alias: params.alias, cmd, streaming: false, status: 'pending' });
        history.logTask(job);
        ssh.executeCommand(job.id);
        const finalJob = await waitForJobCompletion(job.id, config.syncTimeout);
        return { content: [{ type: "text", text: finalJob ? `Commande envoyée à la session '${params.session}'.` : buildAsyncMessage(job, "tmux exec") }] };
    }
);

server.registerTool(
    "tmux_read",
    {
        title: "Lire le buffer d'une session tmux",
        description: "Récupère le contenu affiché dans une session tmux.",
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur."),
            session: z.string().describe("Nom de la session tmux.")
        })
    },
    async (params) => {
        const tmuxCheck = await checkTmux(params.alias);
        if (!tmuxCheck.installed) return { content: [{ type: "text", text: tmuxCheck.message }] };
        const cmd = `tmux capture-pane -t ${params.session} -p -S -200`;
        const job = queue.addJob({ type: 'ssh', alias: params.alias, cmd, streaming: false, status: 'pending' });
        history.logTask(job);
        ssh.executeCommand(job.id);
        const finalJob = await waitForJobCompletion(job.id, config.syncTimeout);
        const output = finalJob ? (finalJob.output || '(vide)') : 'Timeout';
        return { content: [{ type: "text", text: `Buffer de la session '${params.session}':\n\n${output}` }] };
    }
);

server.registerTool(
    "tmux_list",
    {
        title: "Lister les sessions tmux",
        description: "Liste toutes les sessions tmux actives sur un serveur.",
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur.")
        })
    },
    async (params) => {
        const tmuxCheck = await checkTmux(params.alias);
        if (!tmuxCheck.installed) return { content: [{ type: "text", text: tmuxCheck.message }] };
        const cmd = "tmux list-sessions 2>/dev/null || echo '(aucune session tmux)'";
        const job = queue.addJob({ type: 'ssh', alias: params.alias, cmd, streaming: false, status: 'pending' });
        history.logTask(job);
        ssh.executeCommand(job.id);
        const finalJob = await waitForJobCompletion(job.id, config.syncTimeout);
        const output = finalJob ? (finalJob.output || '(vide)') : 'Timeout';
        return { content: [{ type: "text", text: `Sessions tmux sur ${params.alias}:\n${output}` }] };
    }
);

server.registerTool(
    "tmux_kill",
    {
        title: "Tuer une session tmux",
        description: "Supprime une session tmux.",
        inputSchema: z.object({
            alias: z.string().describe("Alias du serveur."),
            session: z.string().describe("Nom de la session à tuer.")
        })
    },
    async (params) => {
        const tmuxCheck = await checkTmux(params.alias);
        if (!tmuxCheck.installed) return { content: [{ type: "text", text: tmuxCheck.message }] };
        const cmd = `tmux kill-session -t ${params.session} 2>/dev/null && echo 'Session ${params.session} tuée.' || echo 'Session introuvable.'`;
        const job = queue.addJob({ type: 'ssh', alias: params.alias, cmd, streaming: false, status: 'pending' });
        history.logTask(job);
        ssh.executeCommand(job.id);
        const finalJob = await waitForJobCompletion(job.id, config.syncTimeout);
        const output = finalJob ? (finalJob.output || 'OK') : 'Timeout';
        return { content: [{ type: "text", text: output }] };
    }
);

// --- OUTILS TUNNELS SSH ---

server.registerTool(
    "tunnel_create",
    {
        title: "Créer un tunnel SSH",
        description: "Crée un tunnel SSH (local/remote/SOCKS5). source=null → local, source=alias → tmux sur le serveur distant. Le tunnel persiste via tmux si source est un serveur.",
        inputSchema: z.object({
            name: z.string().describe("Nom unique du tunnel (ex: 'crm-dev')."),
            type: z.enum(['local', 'remote', 'socks']).describe("local=-L, remote=-R, socks=-D"),
            listen_port: z.number().int().positive().describe("Port d'écoute (ex: 8080)."),
            target: z.string().optional().describe("Cible host:port (ex: '127.0.0.1:3100'). Non requis pour SOCKS."),
            via: z.string().describe("Serveur de transit SSH (alias)."),
            source: z.string().optional().describe("Où le tunnel tourne. null=local, ou alias serveur (ex: 'fkomprodmini2')."),
            key_path: z.string().optional().describe("Chemin de la clé SSH sur le serveur source (requis si source est distant).")
        })
    },
    async (params) => {
        try {
            const result = await tunnels.create(params, servers);
            return { content: [{ type: "text", text: result }] };
        } catch (e) {
            return { content: [{ type: "text", text: JSON.stringify({ toolName: "tunnel_create", errorCode: "TUNNEL_ERROR", errorMessage: e.message }, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "tunnel_list",
    {
        title: "Lister les tunnels",
        description: "Liste tous les tunnels SSH actifs et leur état.",
        inputSchema: z.object({})
    },
    async () => {
        const result = await tunnels.list();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);

server.registerTool(
    "tunnel_close",
    {
        title: "Fermer un tunnel",
        description: "Ferme un tunnel SSH par son nom.",
        inputSchema: z.object({
            name: z.string().describe("Nom du tunnel à fermer.")
        })
    },
    async (params) => {
        try {
            const result = await tunnels.close(params.name, servers);
            return { content: [{ type: "text", text: result }] };
        } catch (e) {
            return { content: [{ type: "text", text: JSON.stringify({ toolName: "tunnel_close", errorCode: "TUNNEL_ERROR", errorMessage: e.message }, null, 2) }], isError: true };
        }
    }
);

server.registerTool(
    "tunnel_allowlist_add",
    {
        title: "Ajouter un port à l'allowlist des tunnels",
        description: "Autorise un port pour les tunnels SSH (sécurité).",
        inputSchema: z.object({
            port: z.number().int().positive().describe("Port à autoriser (ex: 3306).")
        })
    },
    async (params) => {
        const list = await tunnels.allowlistAdd(params.port);
        return { content: [{ type: "text", text: `Port ${params.port} ajouté à l'allowlist.\nPorts autorisés: ${list.join(', ')}` }] };
    }
);

server.registerTool(
    "tunnel_allowlist_remove",
    {
        title: "Retirer un port de l'allowlist des tunnels",
        description: "Supprime un port de la liste des ports autorisés.",
        inputSchema: z.object({
            port: z.number().int().positive().describe("Port à retirer.")
        })
    },
    async (params) => {
        const list = await tunnels.allowlistRemove(params.port);
        return { content: [{ type: "text", text: `Port ${params.port} retiré de l'allowlist.\nPorts autorisés: ${list.join(', ')}` }] };
    }
);

// --- GUIDE IA (manuel intégré) ---

server.registerTool(
    "guide",
    {
        description: "Manuel pour l'IA pilote : workflows copier-coller, cheatsheet, pièges à éviter. Complémentaire de 'help' (qui liste les outils). Appelle guide (section:'index') en début de session pour charger les bonnes pratiques.",
        inputSchema: z.object({
            section: z.enum(['index', 'sources', 'file-editing', 'workflows', 'cheatsheet', 'audit', 'security', 'pitfalls']).optional().default('index').describe("Section du guide")
        })
    },
    async (params) => {
        return { content: [{ type: "text", text: guide.get(params.section) }] };
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
    tunnels.shutdown();
    await queue.shutdown();
    sshPool.closeAll();
    shellSessions.closeAll();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((error) => {
    console.error("Erreur fatale du serveur:", error);
    process.exit(1);
});
