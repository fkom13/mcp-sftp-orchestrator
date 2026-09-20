# Changelog — MCP Orchestrator (`@fkom13/mcp-sftp-orchestrator`)

## 11.8.0 — Security Refresh (2026-09-20)

- Met à jour `@modelcontextprotocol/sdk` de 1.29.x vers **1.30.0**.
- Met à jour `glob` vers **13.0.6** et `uuid` vers **11.1.1+**.
- Rafraîchit les dépendances transitives vulnérables (`ajv`, `fast-uri`, `minimatch`, `picomatch`, `qs`, `hono`, `ip-address`, `@hono/node-server`, brace expansion).
- `npm audit --omit=dev` passe de 11 vulnérabilités à **0**.
- Ajoute `.npmignore` pour empêcher la publication de `.gencodedoc/`, `data/`, `.env`, backups et artefacts locaux dans npm.
- Exclut `.gencodedoc` de ses propres scans afin d'éviter l'auto-indexation récursive des snapshots locaux.
- Conserve le transport MCP **stdio**, les 82 tools/capabilities et les hardenings 11.6/11.7 sans réduction de surface.
- Réaligne les constantes/runtime/tests/docs de version sur 11.8.0.
- Cette release devient la base de réalignement GitHub/npm et des vendors IACA.

## 11.7.0 — AIX / Infrastructure Topology (2026-08-22)

- Conserve les **82 capabilities/tools** : aucune réduction artificielle de surface.
- Ajoute des **annotations MCP standard sur les 82 tools** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) via `toolMetadata.js`; les policies serveur restent l'autorité.
- Clarifie les descriptions de choix entre `system_diagnostics`, `infra_audit`, `fleet_status`, `server_inventory`, `infra_overview`, les familles exec/terminal/transfer/file/snapshot.
- Transforme `infra_overview` : sans alias = contexte de parc léger; avec alias/group/all = **topologie live** listeners + Docker/Compose + PM2 + systemd + Nginx avec graphe `domain -> proxy -> host port -> container/service`.
- Ajoute `outputSchema` + `structuredContent` à `infra_overview`.
- Cache topologique court (2 min), `force`, timeout par machine et réponse compacte par défaut.
- Fusionne les server blocks Nginx HTTP/HTTPS d'un même domaine dans une vue unique.
- `task_queue` et `task_history` deviennent filtrables/paginables/compactables; `task_logs` borne son volume.
- Nouvelle suite `test_aix_117.js`; certification MCP réelle : 82/82 tools annotés.
- Smoke live Contabo certifié : 52 conteneurs, 24 projets Compose, 60 listeners, 30 domaines agrégés; résolution automatique de routes IACA/Connect/Hermes/DeepSeek/NIM/etc.

Archive candidate PC2 : `~/ea-audits/orchestrator-20260822/mcp-sftp-orchestrator-11.7.0-source.tgz`.


Format basé sur [Keep a Changelog](https://keepachangelog.com/).  
Versions snappshottées via **gencodedoc** (IDs locaux sur le dépôt).

---

## [11.6.1] — 2026-08-22

### Hardening MCP / multi-agent
- `server_to_server` supporte désormais les dossiers et le multi-fichiers ; comptage d'échec corrigé.
- `force:false` est enfin respecté en transfert serveur→serveur.
- `task_transfer_multi` accepte `server_to_server` avec `source_alias` global ou par entrée.
- `MCP_ALLOWED_ROOTS` descend au niveau `sourceAdapter` et bloque aussi les échappements par symlink.
- Guards `MCP_READONLY` / `readonly:true` ajoutés aux transferts, exec interactifs/séquences, shell, restores, tmux, tunnels et mutations de registres.
- Quoting tmux/tunnels durci via `escapeShellArg`.
- Interpolations shell restantes durcies (`fail2ban`, nom PM2, `docker --since`).
- Nouvelle suite `test_hardening_1161.js`.

## [11.6.0] — 2026-07-15

**Snapshot gencodedoc : #22 (dev) → #23 (final docs)**  
**82 tools MCP**

### Added — couche sémantique agent (A–E)

- **Projets** (`projects.js`)
  - `project_list` / `project_get` / `project_set` / `project_remove` / `project_resolve`
  - Registre `data/projects.json` : local path ↔ remote alias/path/runtime/url
  - Seed exemple : projet `p-image`
- **`project_diff`** : diff local↔remote d’un projet (ignore patterns du registre)
- **Work sessions** (`workSession.js`)
  - `work_start` / `work_log` / `work_list` / `work_end`
  - Journal `data/work_sessions.json` ; `work_end` met à jour `server_note` (`last_intervention`)
  - Option snapshot remote au démarrage
- **`server_inventory`** (`inventory.js`) : inventaire léger (host, disk, mem, pm2, docker, `$HOME`, tailscale) avec **cache 10 min**
- **RO par alias** : `server_add.readonly` / `servers.json` `readonly:true` bloque write/exec sur cet alias
- **`MCP_COMPACT` / `compact:true`** : `utils.compactResult` pour réponses agent plus courtes

### Added — trust SSH (v11.6 roadmap)

- **`ssh_authorize_key`** (`sshTrust.js`)
  - Ajoute une **pubkey** dans `authorized_keys` distant
  - Sources : `string` | `local_path` (.pub) | `alias` (dérive `.pub` / `ssh-keygen -y`)
  - **Jamais** de copie de clé privée
  - `dry_run: true` par défaut ; chmod 700/600 du `.ssh`

### Security / hardening (portés depuis 11.3–11.4)

- Masquage secrets dans `api_list`, `server_list`, `system_diagnostics`, `infra_audit`
- Policy blocklist sur `shell_exec` et chaque étape de `task_exec_sequence`
- Fix faux positif blocklist `rm -rf /` vs `rm -rf /tmp/...`
- Port SSH configurable (`serverConfig.port`, défaut 22)
- `waitForJobCompletion` : statuts terminaux `partial` + `crashed`
- Fix timeout interactif (secondes confondues avec ms)
- Pool SSH rewrite : listeners non empilés, flag `ready`/`closed`
- `MCP_READONLY=1` global + dry-run commandes destructives sur `task_exec`

### Tests

- `test_p0_unit.js` (24) — utils, policies, secrets, timeouts
- `test_p1_unit.js` (12) — groups, purge, destructive, version
- `test_p16_unit.js` (7) — projects, work session, compact, sshTrust
- `npm test` / `npm test:unit`

### Data files

| Fichier | Rôle |
|---------|------|
| `data/projects.json` | Registre projets |
| `data/work_sessions.json` | Sessions de travail |
| `data/server_groups.json` | Groupes d’alias (v11.4) |
| `data/servers.json` | Alias SSH (+ `readonly?`, `port?`) |

---

## [11.4.0] — 2026-07-15

**Snapshot gencodedoc : #21** · **70 tools**

### Added

- `fleet_status` — ping SSH parallèle (latence, load, disk, clé manquante)
- `infra_audit` — synthèse parc (version, serveurs masqués, notes, crashed, pool)
- `server_group_list` / `server_group_set` / `server_group_remove` — groupes (`group:oci`, …)
- `task_retry_all` — relance bulk crashed/failed (+ dry_run)
- `task_purge` — purge queue (dry_run par défaut)
- `task_exec` : résolution `all` / `group:x` / nom de groupe ; dry_run / force sur commandes destructives
- Modules : `fleet.js`, `groups.js`

### Fixed

- Pool SSH : retry sans empiler les listeners ; readiness réelle
- SFTP `server_to_server` 100 % via pool `sourceAdapter` (plus de client SFTP inutile)
- Queue : `maxQueueSize` / `saveInterval` lus depuis config

---

## [11.3.0] — 2026-07-15

**Snapshot gencodedoc : #20** · alignement version runtime/package

### Security

- `utils.redactSensitiveObject` / `maskSecret` sur diagnostics et listes API
- Policy sur shell + sequences
- Warning secrets en clair au boot

### Fixed

- Interactive hybrid wait (timeout secondes vs ms)
- Job status `partial` considéré terminal
- Port SSH non hardcodé 22 partout
- Blocklist ancrage pour patterns finissant par `/`
- Double `sftp.end()` supprimé ; glob remote en `path.posix`

### Added

- `test_p0_unit.js`

---

## [11.x / 10.x] — antérieurs (résumé)

| Version | Highlights |
|---------|------------|
| 10.4.0 | `sourceSchema` centralisé, `server_to_server` transfert |
| 10.3.0 | guide, notes, infra_overview, diffFormatter |
| 10.2.0 | File ops / diff / snapshot via pool SSH |
| 10.0.0 | Snapshots infra content-addressable |
| 9.3.0 | Shell sessions PTY persistantes |
| 9.2.0 | diff_files / diff_folders / compare_all_sources |
| 9.1.0 | file_read / write / edit + hash |
| 9.0.x | stdio only, help, sécu escapeShellArg |
| 8.x | SFTP force, timeouts, interactif, pool |

Voir aussi `ROADMAP.md` et `ROADMAP_EXTENDED.md` pour le détail historique des étapes 7–11.

---

## Liens

- Package : `@fkom13/mcp-sftp-orchestrator`
- Entry : `server.js` (stdio MCP)
- Tests : `npm test:unit` · `npm test`
- Snapshots code : gencodedoc dans le dépôt projet
