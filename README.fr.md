# 🚀 MCP Orchestrator — Serveur d'orchestration SSH/SFTP

**Version** : 11.3.0  
**License** : MIT  
**Node** : >= 18.0.0

Un serveur MCP (Model Context Protocol) qui donne à un agent IA la capacité d'exécuter des commandes SSH, des transferts SFTP, et du monitoring sur des serveurs distants. File d'attente persistante, pool de connexions SSH, exécution hybride synchrone/asynchrone.

### ✨ Fonctionnalités clés
- **63 outils MCP** — SSH, SFTP, fichiers, monitoring, snapshots, tunnels
- **Sécurité intégrée** — Blocklist de commandes, allowlist de ports, hash protection
- **Multi-serveur** — `task_exec {alias:["vps1","vps2"]}` ou `alias:"all"}`
- **Persistance** — tmux + file d'attente = sessions qui survivent aux crashs
- **Snapshots** — Versionning dédupliqué de vos fichiers critiques
- **Tunnels SSH** — Local, Remote, SOCKS5 avec allowlist sécurisée
- **Guide IA** — Manuel intégré pour l'agent (section:index/workflows/audit/security)

---

## 📦 Installation

### Via npx (recommandé)
```bash
npx @fkom13/mcp-sftp-orchestrator
```

### Via git
```bash
git clone https://github.com/fkom13/mcp-sftp-orchestrator.git
cd mcp-sftp-orchestrator
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

## 🧰 Référence des Outils (63 outils)

### Aide & Diagnostic
| Outil | Description |
|-------|-------------|
| `help` | Guide complet : liste des outils, variables .env, schémas des paramètres |
| `guide` | Manuel IA : workflows, cheatsheet, audit, sécurité |
| `system_diagnostics` | Diagnostic complet (queue, pool, serveurs, APIs) |

### Gestion des Serveurs
| Outil | Description |
|-------|-------------|
| `server_add` | Ajouter/modifier un alias de serveur |
| `server_list` | Lister tous les serveurs configurés |
| `server_remove` | Supprimer un alias de serveur |
| `infra_overview` | Vue synthétique du parc (rôles, services, warnings) |
| `server_note_set/get/list/remove` | Contexte documenté de chaque serveur |

### Sécurité (Blocklist)
| Outil | Description |
|-------|-------------|
| `policy_blocklist_list` | Lister les commandes bloquées |
| `policy_blocklist_add` | Ajouter un pattern à la blocklist |
| `policy_blocklist_remove` | Retirer un pattern de la blocklist |

### Exécution de Tâches
| Outil | Description |
|-------|-------------|
| `task_exec` | SSH one-shot. Supporte `alias:["vps1","vps2"]` ou `alias:"all"` |
| `task_exec_interactive` | SSH avec gestion des prompts interactifs |
| `task_exec_sequence` | Séquence de commandes SSH |
| `task_transfer` | Transfert SFTP. Supporte `server_to_server` direct |
| `task_transfer_multi` | Transferts multiples avec patterns glob |

### Monitoring
| Outil | Description |
|-------|-------------|
| `get_system_resources` | CPU, RAM, Disque d'un serveur |
| `get_services_status` | Statut systemd, Docker, PM2 (graceful fallback) |
| `get_fail2ban_status` | Statut Fail2Ban |
| `check_api_health` | Test HTTP direct |

### Logs
| Outil | Description |
|-------|-------------|
| `get_pm2_logs` | Logs PM2 |
| `get_docker_logs` | Logs Docker |
| `tail_file` | Dernières lignes d'un fichier distant |

### Opérations Fichiers (Local + Remote)
| Outil | Description |
|-------|-------------|
| `file_read` | Lire fichier + hash SHA-256 (protection édition) |
| `file_write` | Créer/écraser avec `dryRun` et `backup` |
| `file_edit` | Édition chirurgicale ou complète + protection hash |

### Comparaison & Drift
| Outil | Description |
|-------|-------------|
| `diff_files` | Comparer 2 fichiers (local/remote, cross-server) |
| `diff_folders` | Comparer 2 dossiers |
| `compare_all_sources` | Détecter les drifts sur N serveurs |

### Sessions Shell Persistantes
| Outil | Description |
|-------|-------------|
| `shell_create` | Ouvrir une session shell (cd/env persistent) |
| `shell_exec` | Exécuter dans une session existante |
| `shell_list` / `shell_close` | Lister/fermer les sessions |

### tmux (Sessions Terminal Survivantes)
| Outil | Description |
|-------|-------------|
| `tmux_create` | Créer une session tmux persistante |
| `tmux_exec` | Envoyer une commande dans une session |
| `tmux_read` | Lire le buffer |
| `tmux_list` / `tmux_kill` | Lister/tuer les sessions |

### Tunnels SSH
| Outil | Description |
|-------|-------------|
| `tunnel_create` | Tunnel local/remote/SOCKS5, persistant via tmux |
| `tunnel_list` | Lister les tunnels actifs |
| `tunnel_close` | Fermer un tunnel |
| `tunnel_allowlist_add/remove` | Gérer les ports autorisés |

### Snapshots (Versioning Fichiers)
| Outil | Description |
|-------|-------------|
| `snapshot_create` | Capturer l'état de fichiers avec déduplication |
| `snapshot_list` | Lister les snapshots |
| `snapshot_diff` | Comparer 2 snapshots |
| `snapshot_restore` | Restaurer (dryRun par défaut) |
| `snapshot_delete` | Supprimer + nettoyage orphelins |

### File d'Attente & Suivi
| Outil | Description |
|-------|-------------|
| `task_queue` | Voir toutes les tâches en cours |
| `task_status` | Détail d'une tâche |
| `task_history` | Historique filtrable |
| `task_retry` | Relancer une tâche échouée |
| `task_wait` | Attendre une tâche arrière-plan |
| `task_logs` | Logs internes MCP |
| `queue_stats` / `pool_stats` | Statistiques queue et pool SSH |

### Gestion des APIs
| Outil | Description |
|-------|-------------|
| `api_add` / `api_list` / `api_remove` | Catalogue d'APIs |
| `api_check` | Test de santé via SSH + curl |

---

## 📖 Exemples d'utilisation

### Multi-serveur
```bash
# Une commande sur plusieurs serveurs
task_exec {alias:["vps1","vps2","vps3"], cmd:"uptime"}

# Tout le parc
task_exec {alias:"all", cmd:"df -h /"}
```

### Tunnel SOCKS5 (proxy)
```bash
tunnel_create {name:"proxy", type:"socks", listen_port:1080, via:"vps_paris"}
# → Navigateur → SOCKS5 127.0.0.1:1080 → VPS Paris
```

### Tunnel local (accès service distant)
```bash
tunnel_create {name:"crm", type:"local", listen_port:8080, target:"127.0.0.1:3100", via:"vps_prod"}
# → http://localhost:8080 → CRM en production
```

### Tunnel remote (exposer un service local)
```bash
tunnel_create {name:"dev", type:"remote", listen_port:9090, target:"127.0.0.1:3000", via:"vps", source:"vps_prod", key_path:"/home/user/.ssh/vps.key"}
# → vps_prod:9090 → votre machine locale:3000
```

### Session tmux persistante
```bash
tmux_create {alias:"vps", name:"build", start_cmd:"npm run build"}
tmux_read {alias:"vps", session:"build"}
tmux_kill {alias:"vps", session:"build"}
```

### Blocklist (sécurité)
```bash
# Voir les commandes bloquées
policy_blocklist_list
# → ["rm -rf /", "mkfs*", ...]

# Contournement conscient
task_exec {alias:"vps", cmd:"rm -rf /tmp/cache", skip_policy:true}
```

### Édition de fichier sécurisée
```bash
# Lire + hash
file_read {source:{type:"remote", alias:"vps", path:"/etc/nginx/nginx.conf"}}
# → content + hash

# Éditer avec protection
file_edit {source:{type:"remote", alias:"vps", path:"/etc/nginx/nginx.conf"},
           oldString:"worker_connections 768;",
           newString:"worker_connections 1024;",
           expectedHash:"abc123...",
           backup:true}

# Preview sans écrire
file_edit {source:{type:"remote", alias:"vps", path:"/etc/nginx/nginx.conf"},
           oldString:"worker_connections 768;",
           newString:"worker_connections 1024;",
           dryRun:true}
```

### Snapshot avant modif risquée
```bash
# Avant
snapshot_create {source:{type:"remote", alias:"vps"}, paths:["/etc/nginx/"], tag:"before-fix"}

# Après si problème
snapshot_restore {snapshotId:"...", target:{type:"remote", alias:"vps"}, dryRun:false, force:true}
```

### Drift detection (comparaison multi-serveur)
```bash
compare_all_sources {sources:[
  {type:"remote", alias:"vps1", path:"/etc/nginx/nginx.conf", label:"prod"},
  {type:"remote", alias:"vps2", path:"/etc/nginx/nginx.conf", label:"staging"}
]}
```

---

## 🏗️ Architecture

```
Client MCP (stdio)
    │
server.js ─── 63 outils MCP enregistrés
    │
    ├── queue.js ─────── File d'attente persistante (JSON + backup)
    ├── ssh.js ───────── Exécution SSH (pool + connexions dédiées)
    ├── sftp.js ──────── Transferts SFTP (upload/download/multi)
    ├── sshPool.js ───── Pool de connexions SSH persistantes
    ├── servers.js ───── CRUD alias de serveurs
    ├── apis.js ──────── CRUD catalogue d'APIs
    ├── history.js ───── Historique des tâches
    ├── config.js ────── Configuration centralisée
    ├── utils.js ─────── Utilitaires (escapeShellArg)
    ├── fileOps.js ───── Opérations fichiers (read/write/edit)
    ├── diffEngine.js ── Moteur de diff (fichiers/dossiers/sources)
    ├── compareEngine.js ─ Comparaison multi-sources
    ├── diffFormatter.js ─ Formatage des diffs
    ├── sourceAdapter.js ─ Abstraction local/remote
    ├── shellSessions.js ─ Sessions shell persistantes
    ├── snapshotManager.js ─ Snapshots versionnés
    ├── notes.js ──────── Contexte documenté des serveurs
    ├── policies.js ──── Blocklist de commandes
    ├── tunnels.js ────── Tunnels SSH (local/remote/SOCKS)
    ├── guide.js ──────── Manuel IA intégré
    └── diagnose.js ───── Diagnostics
```

### Cycle de vie d'un job

```
pending → running → completed / failed
                      ↓ (si redémarrage)
                    crashed → retry → pending
```

---

## 📚 Manuel IA intégré (guide)

L'orchestrator embarque un manuel interactif pour l'agent IA :

```bash
guide section:index       # Table des matières
guide section:workflows   # Recettes copier-coller
guide section:cheatsheet  # Table outil → usage
guide section:audit       # Audit complet du parc en 8 étapes
guide section:security    # Blocklist + tunnels
guide section:pitfalls    # Pièges à éviter
```

---

## 🔒 Sécurité

- **Command Blocklist** : `rm -rf /`, `mkfs*`, fork bombs et autres commandes destructrices sont bloquées par défaut
- **Contournement conscient** : `skip_policy: true` pour forcer l'exécution
- **Allowlist de ports tunnels** : seuls les ports explicitement autorisés peuvent être utilisés
- **`escapeShellArg()`** : toutes les URLs et chemins sont échappés avant passage à curl/shell
- **Détection de secrets en clair** : warning au démarrage si mots de passe/clés API en clair
- **Snapshots avant modif** : `backup:true` sur file_edit/file_write pour annuler une erreur
- **Recommandation** : clés SSH (pas de mots de passe), stockez les secrets dans Vaultwarden

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
| 10.0.0 | Nouveaux outils : file_read/write/edit, diff, snapshots, shell, notes |
| 10.4.0 | server_to_server, help avec schémas, guide audit |
| 11.0.0 | Command Blocklist, Multi-host (`alias:"all"`), tmux |
| 11.3.0 | Tunnels SSH (local/remote/SOCKS5), allowlist, fix ssh2 stderr |
| 12.0.0 (planifié) | Auto-setup clés tunnels, webhooks, dashboard statique |

---

## 📄 Licence

MIT — Copyright (c) 2025-2026 Franck (fkom13)