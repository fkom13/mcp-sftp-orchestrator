# 🚀 MCP Orchestrator — Serveur d'orchestration SSH/SFTP

**Version** : 9.0.1  
**License** : MIT  
**Node** : >= 18.0.0

Un serveur MCP (Model Context Protocol) qui donne à un agent IA la capacité d'exécuter des commandes SSH, des transferts SFTP, et du monitoring sur des serveurs distants. File d'attente persistante, pool de connexions SSH, exécution hybride synchrone/asynchrone.

---

## 📦 Installation

```bash
git clone https://github.com/fkom13/mcp-sftp-orchestrator.git
cd sftp-mcp
npm install
cp .env.example .env
# Éditer .env avec vos chemins
```

Prérequis : Node.js >= 18.0.0

---

## ⚙️ Configuration (.env)

Toutes les variables sont optionnelles. Les valeurs par défaut sont conçues pour un usage standard.

| Variable | Défaut | Description |
|----------|--------|-------------|
| `MCP_DATA_DIR` | `~/.config/mcp-orchestrator` | Dossier où sont stockés `servers.json`, `apis.json`, `queue.json`, `history.json` |
| `MCP_SYNC_TIMEOUT_S` | `120` | Délai en secondes avant qu'une tâche passe en arrière-plan (retour immédiat au client, tâche continue) |
| `MCP_DEFAULT_CMD_TIMEOUT_S` | `600` | Timeout SSH par défaut en secondes. `0` = aucune limite |
| `MCP_INTERACTIVE_CMD_TIMEOUT_S` | `300` | Timeout pour les commandes interactives. `0` = aucune limite |
| `MCP_MAX_WAIT_TIMEOUT_S` | `600` | Timeout maximum pour l'outil `task_wait` |
| `MAX_CONNECTIONS_PER_SERVER` | `5` | Nombre max de connexions SSH simultanées par serveur |
| `MIN_CONNECTIONS_PER_SERVER` | `1` | Nombre min de connexions SSH maintenues par serveur |
| `IDLE_TIMEOUT` | `300000` | Délai en ms avant fermeture d'une connexion SSH inactive (5 min) |
| `KEEP_ALIVE_INTERVAL` | `30000` | Intervalle keepalive SSH en ms (30s) |
| `MAX_QUEUE_SIZE` | `1000` | Nombre maximum de jobs dans la file d'attente |
| `SAVE_INTERVAL` | `5000` | Intervalle de sauvegarde de la queue sur disque en ms (5s) |
| `MCP_DEBUG` | `false` | `true` pour activer les logs détaillés dans stderr |

---

## 🔌 Connexion au client MCP (OpenCode, Claude Desktop, etc.)

```json
{
  "mcpServers": {
    "orchestrator": {
      "command": "node",
      "args": ["/chemin/vers/sftp-mcp/server.js"],
      "env": {
        "MCP_DATA_DIR": "/chemin/vers/sftp-mcp/data"
      }
    }
  }
}
```

---

## 🧰 Référence des Outils (29 outils)

### Diagnostic & Aide
| Outil | Description |
|-------|-------------|
| `help` | Guide complet : liste des outils, variables .env, astuces d'utilisation |
| `system_diagnostics` | Diagnostic complet (queue, pool, serveurs, APIs). `verbose:true` pour les logs |

### Gestion des Serveurs
| Outil | Description |
|-------|-------------|
| `server_add` | Ajouter/modifier un alias de serveur (host, user, keyPath ou password) |
| `server_list` | Lister tous les serveurs configurés avec leurs détails |
| `server_remove` | Supprimer un alias de serveur |

### Gestion du Catalogue API
| Outil | Description |
|-------|-------------|
| `api_add` | Ajouter une API au catalogue de monitoring |
| `api_list` | Lister toutes les APIs configurées |
| `api_remove` | Supprimer une API du catalogue |
| `api_check` | Test de santé d'une API via son alias (utilise SSH + curl) |

### Exécution de Tâches
| Outil | Description |
|-------|-------------|
| `task_exec` | Exécuter une commande SSH. Paramètre `timeout` en secondes (`0` = infini) |
| `task_exec_interactive` | SSH avec gestion des prompts (yes/no, menus, passwords). Supporte `responses` avec regex |
| `task_exec_sequence` | Séquence de plusieurs commandes SSH sur le même serveur |
| `task_transfer` | Transfert SFTP fichier ou dossier. `force:true` pour écraser sans confirmation |
| `task_transfer_multi` | Transferts SFTP multiples avec support de patterns glob (`*`, `?`, `[]`) |

### Monitoring
| Outil | Description |
|-------|-------------|
| `get_system_resources` | CPU, RAM, Disque d'un serveur |
| `get_services_status` | Statut des services systemd, Docker, PM2 |
| `get_fail2ban_status` | Statut Fail2Ban (toutes les jails ou une spécifique) |
| `check_api_health` | Test HTTP direct sur une URL (via SSH + curl) |

### Logs
| Outil | Description |
|-------|-------------|
| `get_pm2_logs` | Logs PM2 d'une application spécifique ou toutes |
| `get_docker_logs` | Logs d'un container Docker |
| `tail_file` | Dernières lignes d'un fichier distant (équivalent `tail -n`) |

### File d'Attente & Suivi
| Outil | Description |
|-------|-------------|
| `task_queue` | Voir toutes les tâches (en cours, en attente, terminées) |
| `task_status` | Détail complet d'une tâche par son ID |
| `task_history` | Historique des tâches exécutées, filtrable par alias |
| `task_retry` | Relancer une tâche échouée ou crashée |
| `task_wait` | Attendre la fin d'une tâche passée en arrière-plan (jusqu'à 600s) |
| `task_logs` | Logs internes du système MCP |
| `queue_stats` | Statistiques de la file d'attente |
| `pool_stats` | Statistiques du pool de connexions SSH |

---

## 📖 Guide d'Utilisation

### Commandes longues (docker build, grosses installs)

```
1. Lancer avec timeout:0 → task_exec { alias: "vps", cmd: "docker build ...", timeout: 0 }
2. Si ça dépasse 120s → passe en arrière-plan avec un ID
3. Récupérer le résultat → task_wait { id: "abc123" }
```

### Transferts SFTP (façon FileZilla)

- **Fichier nouveau** : upload/download sans rien de spécial
- **Fichier existe déjà** : refusé avec message "Utilisez force:true pour écraser"
- **Avec `force: true`** : écrase sans rien demander
- **Dossier → dossier** : transfert récursif automatique
- **Patterns glob** : `task_transfer_multi` avec `*.txt`, `data?.json`, etc.

### Mode interactif

```json
{
  "alias": "vps",
  "cmd": "apt upgrade",
  "interactive": true,
  "autoRespond": true,
  "responses": {
    "Do you want to continue": "y",
    "restart services": "yes"
  }
}
```

Les clés de `responses` supportent les expressions régulières. Ex: `"[YyNn]\\\\?"` → `"y"`.

---

## 🏗️ Architecture

```
Client MCP (stdio ou HTTP)
    │
server.js ─── 29 outils MCP enregistrés
    │
    ├── queue.js ─── File d'attente persistante (JSON + backup auto)
    ├── ssh.js ───── Exécution SSH (pool ou connexion dédiée interactive)
    ├── sftp.js ──── Transferts SFTP (upload/download, glob, force)
    ├── sshPool.js ─ Pool de connexions SSH persistantes (max 5/serveur)
    ├── servers.js ─ CRUD alias de serveurs
    ├── apis.js ──── CRUD catalogue d'APIs
    ├── history.js ─ Historique des 500 dernières tâches
    ├── config.js ── Configuration centralisée (CLI > .env > defaults)
    └── utils.js ─── Utilitaires (escapeShellArg)
```

### Cycle de vie d'un job

```
pending → running → completed / failed
                      ↓ (si redémarrage pendant running)
                    crashed → retry → pending
```

---

## 🔒 Sécurité

- **`escapeShellArg()`** : toutes les URLs et chemins sont échappés avant d'être passés à curl/shell
- **Détection de secrets en clair** : au démarrage, un warning est loggé si `servers.json` ou `apis.json` contiennent des mots de passe/clés API
- **Recommandation** : utilisez des clés SSH (pas de mots de passe) et stockez les clés API dans Vaultwarden plutôt qu'en clair

---

## 🧪 Tests

```bash
node diagnose.js        # Diagnostic complet
node test_mcp.js        # Test smoke MCP
node test_features.js   # Tests unitaires (queue, pool, glob, prompts, crash)
```

---

## 🛣️ Roadmap

| Version | Changement |
|---------|------------|
| 8.2.0 | Ménage, uniformisation erreurs, nettoyage logs |
| 8.3.0 | Transferts SFTP blindés (fichier vs dossier, force:true) |
| 8.4.0 | Timeouts longues opérations, task_wait |
| 8.5.0 | SSH interactif amélioré (menus, regex, password) |
| 8.6.0 | Sécurité (escapeShellArg, détection secrets) |
| 9.0.0 | Nettoyage, uniformisation finale, outil help, transport stdio uniquement |
| 9.0.1 | Corrections sécurité (injection shell, vestiges code) |

---

## 📄 Licence

MIT — Copyright (c) 2025-2026 Franck (fkom13)