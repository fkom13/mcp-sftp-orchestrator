# 🚀 MCP Orchestrator — Serveur d'orchestration SSH/SFTP

> **v11.8.0 Security Refresh** — Les 82 tools publient désormais les annotations MCP standard. `infra_overview` reste léger sans argument, mais `infra_overview { alias: "..." }` effectue une découverte live et corrèle Nginx/domaines, ports, Docker/Compose et services. Voir `CHANGELOG.md`.


**Version** : 11.8.0  
**Tools** : 82  
**License** : MIT  
**Node** : >= 18.0.0  
**Changelog** : [CHANGELOG.md](./CHANGELOG.md)

Serveur MCP (Model Context Protocol, transport **stdio**) qui donne à un agent IA la capacité d’orchestrer un parc de serveurs : SSH, SFTP, édition de fichiers locale/remote (hash-safe), diffs cross-server, shell PTY, snapshots d’infra, notes de protocole, **projets**, **sessions de travail**, inventaire, trust SSH (pubkey), groupes d’alias et audit parc.

---

## ✨ Points forts (v11.6)

| Domaine | Capacité |
|---------|----------|
| **Exécution** | `task_exec` multi-serveur / `group:oci` / dry-run destructif / force |
| **Fichiers** | `file_read` / `file_edit` (chirurgical) / `file_write` + hash + dryRun + backup |
| **Parc** | notes, `infra_audit`, `fleet_status`, `server_inventory` |
| **Projets** | registre local↔remote + `project_diff` |
| **Travail** | `work_start` → edits → `work_end` (note d’intervention auto) |
| **Trust** | `ssh_authorize_key` (pubkey only, dry_run par défaut) |
| **Sécu** | secrets masqués, RO global + **RO par alias**, blocklist, pool SSH robuste |

---

## 📦 Installation

```bash
git clone https://github.com/fkom13/mcp-sftp-orchestrator.git
cd sftp-mcp   # ou tools/sftp-mcp
npm install
cp .env.example .env
# Éditer MCP_DATA_DIR et chemins de clés
```

Prérequis : **Node.js >= 18**

---

## ⚙️ Configuration (`.env`)

Toutes les variables sont optionnelles.

| Variable | Défaut | Description |
|----------|--------|-------------|
| `MCP_DATA_DIR` | `~/.config/mcp-orchestrator` | Dossier data (JSON, snapshots, projets…) |
| `MCP_SYNC_TIMEOUT_S` | `120` | Délai (s) avant passage d’une tâche en arrière-plan |
| `MCP_DEFAULT_CMD_TIMEOUT_S` | `600` | Timeout SSH commande (s). `0` = infini |
| `MCP_INTERACTIVE_CMD_TIMEOUT_S` | `300` | Timeout interactif (s). `0` = infini |
| `MCP_MAX_WAIT_TIMEOUT_S` | `600` | Timeout max `task_wait` (s) |
| `MAX_CONNECTIONS_PER_SERVER` | `5` | Pool SSH max / serveur |
| `MIN_CONNECTIONS_PER_SERVER` | `1` | Pool SSH min / serveur |
| `IDLE_TIMEOUT` | `300000` | Fermeture connexion inactive (ms) |
| `KEEP_ALIVE_INTERVAL` | `30000` | Keepalive SSH (ms) |
| `MAX_QUEUE_SIZE` | `1000` | Taille max queue jobs |
| `SAVE_INTERVAL` | `5000` | Autosave queue (ms) |
| `MCP_ALLOWED_ROOTS` | _(vide)_ | Racines autorisées pour paths locaux (CSV) |
| `MCP_READONLY` | `false` | `1` = refuse écritures / exec mutantes (global) |
| `MCP_COMPACT` | `false` | `1` = réponses tronquées (tokens agent) |
| `MCP_DEBUG` | `false` | Logs détaillés stderr |

### Fichiers sous `MCP_DATA_DIR`

| Fichier | Contenu |
|---------|---------|
| `servers.json` | Alias SSH (`host`, `user`, `keyPath`/`password`, `port?`, `readonly?`) |
| `apis.json` | Catalogue APIs (secrets masqués en lecture tools) |
| `queue.json` / `queue.backup.json` | Jobs |
| `history.json` | Historique tâches |
| `server_notes.json` | Protocoles / notes par serveur |
| `server_groups.json` | Groupes d’alias |
| `projects.json` | Registre projets |
| `work_sessions.json` | Sessions de travail |
| `policies.json` | Blocklist commandes |
| `tunnels.json` / `tunnel_allowlist.json` | Tunnels SSH |
| `infra_snapshots/` | Snapshots content-addressable |

---

## 🔌 Connexion client MCP

### Grok / config.toml

```toml
[mcp_servers.orchestrator]
command = "node"
args = ["/chemin/absolu/sftp-mcp/server.js"]
# optionnel:
# env = { MCP_DATA_DIR = "/chemin/absolu/sftp-mcp/data" }
```

### OpenCode / Claude Desktop (JSON)

```json
{
  "mcpServers": {
    "orchestrator": {
      "command": "node",
      "args": ["/chemin/absolu/sftp-mcp/server.js"],
      "env": {
        "MCP_DATA_DIR": "/chemin/absolu/sftp-mcp/data"
      }
    }
  }
}
```

Après modification du code : recharger le serveur MCP (`/mcps` → `r` ou restart session). Vérifier `system_diagnostics` → `version: "11.8.0"`.

---

## 🧰 Référence des outils (82)

### Diagnostic & audit
| Outil | Description |
|-------|-------------|
| `help` | Guide outils + .env + astuces |
| `guide` | Manuel IA (workflows, cheatsheet, pitfalls, audit, security) |
| `system_diagnostics` | Queue, pool, serveurs/APIs **masqués**, version, readOnly |
| `infra_audit` | Synthèse parc + projets + notes + crashed |
| `infra_overview` | Serveurs + notes (vue légère) |
| `fleet_status` | Ping SSH parallèle (latence, load, disk) |
| `server_inventory` | Inventaire léger (pm2/docker/disk/home, cache 10 min) |

### Serveurs & groupes
| Outil | Description |
|-------|-------------|
| `server_add` | CRUD alias (`keyPath` ou `password`, `port`, **`readonly`**) |
| `server_list` | Liste (passwords masqués) |
| `server_remove` | Supprime un alias |
| `server_group_list/set/remove` | Groupes (`oci`, `contabo`…). Usage : `group:oci` ou nom de groupe |

### Projets (v11.6)
| Outil | Description |
|-------|-------------|
| `project_list` / `project_get` / `project_set` / `project_remove` | Registre |
| `project_resolve` | → `{ local, remote, ignore, runtime }` |
| `project_diff` | Diff local↔remote du projet |

Exemple `project_set` :

```json
{
  "name": "p-image",
  "local": { "path": "/home/.../dev-serveur/p-image" },
  "servers": {
    "prod": {
      "alias": "fkomprodmini2_prod",
      "path": "/home/ubuntu/p-image",
      "runtime": { "pm2": "p-image", "port": 5002 },
      "url": "https://pruna.esprit-artificiel.com"
    }
  },
  "ignore": ["node_modules", ".git", "data"]
}
```

### Sessions de travail (v11.6)
| Outil | Description |
|-------|-------------|
| `work_start` | Ouvre un journal (`alias`, `project`, `tag`, snapshot optionnel) |
| `work_log` | Event (`file_edit`, `task_exec`, …) |
| `work_list` | Sessions actives (+ historique) |
| `work_end` | Clôture + `server_note` `last_intervention` |

### Trust SSH (v11.6)
| Outil | Description |
|-------|-------------|
| `ssh_authorize_key` | Ajoute une **pubkey** dans `authorized_keys` distant. `dry_run` défaut. Sources : `string` \| `local_path` \| `alias` |

```json
{
  "target_alias": "fkomprodmini1_prod",
  "source": { "type": "alias", "alias": "vps_contabo" },
  "comment": "fleet-from-contabo",
  "dry_run": true
}
```

### Policies
| Outil | Description |
|-------|-------------|
| `policy_blocklist_list/add/remove` | Blocklist commandes (aussi appliquée à shell + sequences) |

### Catalogue API
| Outil | Description |
|-------|-------------|
| `api_add` / `api_list` / `api_remove` / `api_check` | Monitoring (clés masquées en list) |

### Exécution de tâches
| Outil | Description |
|-------|-------------|
| `task_exec` | SSH ; alias \| tableau \| `all` \| `group:x` ; dry_run/force destructif |
| `task_exec_interactive` | Prompts yes/no, menus |
| `task_exec_sequence` | Séquence sur un serveur (policy par étape) |
| `task_transfer` | SFTP upload/download/`server_to_server` |
| `task_transfer_multi` | Multi + globs |

### Files / Diff / Shell / Snapshots
| Famille | Outils |
|---------|--------|
| Files | `file_read`, `file_write`, `file_edit` |
| Diff | `diff_files`, `diff_folders`, `compare_all_sources` |
| Shell | `shell_create`, `shell_exec` (+ `skip_policy`), `shell_list`, `shell_close` |
| Snapshots | `snapshot_create/list/diff/restore/delete` |

**Édition safe** : `file_read` → hash → `file_edit` + `expectedHash` (+ `dryRun` / `backup`).

### Notes serveur
| Outil | Description |
|-------|-------------|
| `server_note_set/get/list/remove` | Protocole (description, services, warnings, intervention) |

### Monitoring & logs
| Outil | Description |
|-------|-------------|
| `get_system_resources` | CPU / RAM / disque |
| `get_services_status` | systemd / Docker / PM2 |
| `get_fail2ban_status` | Fail2Ban |
| `check_api_health` | HTTP via SSH+curl |
| `get_pm2_logs` / `get_docker_logs` / `tail_file` | Logs |

### Queue
| Outil | Description |
|-------|-------------|
| `task_queue` / `task_status` / `task_history` / `task_wait` / `task_logs` | Suivi |
| `task_retry` / `task_retry_all` | Relance |
| `task_purge` | Purge (dry_run défaut) |
| `queue_stats` / `pool_stats` | Stats |

### Tmux & tunnels
| Outil | Description |
|-------|-------------|
| `tmux_create/exec/read/list/kill` | Sessions tmux distantes |
| `tunnel_create/list/close` | Tunnels SSH local/remote/socks |
| `tunnel_allowlist_add/remove` | Ports autorisés pour tunnels |

---

## 📖 Workflows agent recommandés

### Début de session
```
infra_audit  (ou infra_overview)
fleet_status
project_list / project_resolve
```

### Chantier sur un projet
```
work_start { project: "p-image", alias: "fkomprodmini2_prod", tag: "fix-x", message: "…" }
file_read → file_edit (expectedHash, dryRun puis apply)
work_log { type: "file_edit", path: "…" }
work_end { summary: "…" }   → note serveur mise à jour
project_diff { name: "p-image" }
```

### Commandes longues
```
task_exec { timeout: 0, … }  → si > syncTimeout → task_wait { id }
```

### Cibles multi-serveurs
```
task_exec { alias: "group:oci", cmd: "hostname" }
task_exec { alias: "all", cmd: "uptime" }
```

---

## 🏗️ Architecture

```
Client MCP (stdio)
    │
server.js ─── 82 tools
    │
    ├── queue.js          File d’attente persistante + purge/retry
    ├── ssh.js / sshPool  Exécution + pool (retry safe, port configurable)
    ├── sftp.js           Transferts (server_to_server via sourceAdapter/pool)
    ├── sourceAdapter.js  Local fs | remote SFTP pool
    ├── fileOps.js        Read/write/edit + hash + dryRun + backup
    ├── diffEngine.js / compareEngine.js / diffFormatter.js
    ├── shellSessions.js  PTY persistants + policy
    ├── snapshotManager.js
    ├── projects.js / workSession.js / inventory.js / groups.js / fleet.js
    ├── sshTrust.js       authorized_keys (pubkey only)
    ├── servers.js / apis.js / notes.js / policies.js / tunnels.js
    ├── history.js / guide.js / config.js / utils.js
```

### Cycle de vie d’un job

```
pending → running → completed | failed | partial
                      ↓ (redémarrage MCP pendant running)
                    crashed → task_retry → pending
```

---

## 🔒 Sécurité

| Mécanisme | Détail |
|-----------|--------|
| Secrets | Masqués en `api_list` / diagnostics (`***` + 4 derniers car.) |
| Shell escape | `escapeShellArg` sur curl, logs, chemins |
| Blocklist | `policies.json` ; shell + sequence inclus ; `skip_policy` pour forcer |
| RO global | `MCP_READONLY=1` |
| RO alias | `"readonly": true` dans `servers.json` |
| Destructif | `task_exec` dry-run si pattern dangereux sans `force:true` |
| Trust | Pubkey only ; dry_run par défaut |
| Clés | Préférer `keyPath` SSH ; Vaultwarden pour secrets API |

---

## 🧪 Tests

```bash
npm test:unit    # p0 + p1 + p16 (43 tests)
npm test         # unit + smoke MCP + features
node diagnose.js # diagnostic local optionnel
```

| Fichier | Couverture |
|---------|------------|
| `test_p0_unit.js` | utils, policies, redact, timeouts, version |
| `test_p1_unit.js` | groups, purge, destructive, RO env |
| `test_p16_unit.js` | projects, work session, compact, sshTrust |
| `test_mcp.js` | smoke SDK |
| `test_features.js` | queue / pool / globs / prompts |

---

## 🛣️ Versions récentes

| Version | Contenu | Snapshot gencodedoc |
|---------|---------|---------------------|
| **11.6.1** | Hardening multi-agent: RO transversal, server-to-server dossiers/force, allowed roots anti-symlink, quoting shell/tmux, queue + JSON stores atomiques | — |
| **11.6.0** | Projets, work sessions, inventory, ssh_authorize_key, RO alias, compact | **#23** (final docs) |
| 11.4.0 | fleet, infra_audit, groups, retry_all, purge, pool rewrite | #21 |
| 11.3.0 | Secrets mask, policy shell/seq, port SSH, wait partial | #20 |
| 10.4–10.0 | file ops, diff, shell, snapshots, notes, guide | #17–19 |
| 9.x / 8.x | SFTP force, timeouts, interactif, sécu de base | — |

Détail : **[CHANGELOG.md](./CHANGELOG.md)** · plans historiques : `ROADMAP.md`, `ROADMAP_EXTENDED.md`.

---

## 📄 Licence

MIT — Copyright (c) 2025-2026 Franck (fkom13)
