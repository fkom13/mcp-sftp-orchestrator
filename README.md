# 🚀 MCP Orchestrator — SSH/SFTP Infrastructure Orchestration Server

**Version** : 11.3.0  
**License** : MIT  
**Node** : >= 18.0.0

A Model Context Protocol (MCP) server that turns any AI agent (Claude, OpenCode, Cursor...) into a full-fledged system administrator. Persistent queue, SSH connection pool, hybrid sync/async execution.

### ✨ Key Features
- **63 MCP tools** — SSH, SFTP, file ops, monitoring, snapshots, tunnels
- **Built-in security** — Command blocklist, port allowlist, hash protection
- **Multi-server** — `task_exec {alias:["vps1","vps2"]}` or `alias:"all"}`
- **Persistence** — tmux + persistent queue = sessions that survive crashes
- **Snapshots** — Deduplicated versioning of your critical files
- **SSH Tunnels** — Local, Remote, SOCKS5 with secured port allowlist
- **AI Guide** — Built-in manual for the agent (section:index/workflows/audit/security)

> **🇫🇷 Version française :** [README.fr.md](README.fr.md)

---

## 📦 Installation

### Via npx (recommended)
```bash
npx @fkom13/mcp-sftp-orchestrator
```

### Via git
```bash
git clone https://github.com/fkom13/mcp-sftp-orchestrator.git
cd mcp-sftp-orchestrator
npm install
cp .env.example .env
# Edit .env with your paths
```

Requirements: Node.js >= 18.0.0

---

## ⚙️ Configuration (.env)

All variables are optional. Defaults are designed for standard usage.

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_DATA_DIR` | `~/.config/mcp-orchestrator` | Data directory (servers.json, apis.json, queue.json) |
| `MCP_SYNC_TIMEOUT_S` | `120` | Seconds before background execution |
| `MCP_DEFAULT_CMD_TIMEOUT_S` | `600` | Default SSH timeout (0 = unlimited) |
| `MCP_INTERACTIVE_CMD_TIMEOUT_S` | `300` | Interactive command timeout (0 = unlimited) |
| `MCP_MAX_WAIT_TIMEOUT_S` | `600` | Max timeout for `task_wait` |
| `MAX_CONNECTIONS_PER_SERVER` | `5` | Max parallel SSH connections per server |
| `MIN_CONNECTIONS_PER_SERVER` | `1` | Min pooled connections per server |
| `IDLE_TIMEOUT` | `300000` | Idle connection close delay (ms) |
| `KEEP_ALIVE_INTERVAL` | `30000` | SSH keepalive interval (ms) |
| `MAX_QUEUE_SIZE` | `1000` | Max jobs in queue |
| `SAVE_INTERVAL` | `5000` | Queue disk save interval (ms) |
| `MCP_ALLOWED_ROOTS` | *(empty)* | Restrict file access to these roots (comma-separated). Empty = full access |
| `MCP_DEBUG` | `false` | Enable detailed debug logs |

---

## 🔌 MCP Client Configuration (OpenCode, Claude Desktop, etc.)

```json
{
  "mcpServers": {
    "orchestrator": {
      "command": "node",
      "args": ["/path/to/sftp-mcp/server.js"],
      "env": {
        "MCP_DATA_DIR": "/path/to/sftp-mcp/data"
      }
    }
  }
}
```

---

## 🧰 Tool Reference (63 tools)

### Help & Diagnostics
| Tool | Description |
|------|-------------|
| `help` | Complete guide: tools, env vars, parameter schemas |
| `guide` | AI manual: workflows, cheatsheet, audit, security |
| `system_diagnostics` | Full system diagnostic (queue, pool, servers, APIs) |

### Server Management
| Tool | Description |
|------|-------------|
| `server_add` | Add/update a server alias |
| `server_list` | List all configured servers |
| `server_remove` | Remove a server alias |
| `infra_overview` | Fleet-wide overview (roles, services, warnings) |
| `server_note_set/get/list/remove` | Documented server context |

### Security (Blocklist)
| Tool | Description |
|------|-------------|
| `policy_blocklist_list` | List blocked commands |
| `policy_blocklist_add` | Add a pattern to blocklist |
| `policy_blocklist_remove` | Remove a pattern from blocklist |

### Task Execution
| Tool | Description |
|------|-------------|
| `task_exec` | SSH one-shot. Supports `alias:["vps1","vps2"]` or `alias:"all"` |
| `task_exec_interactive` | SSH with interactive prompt handling |
| `task_exec_sequence` | Sequential SSH commands |
| `task_transfer` | SFTP transfer. Supports `server_to_server` |
| `task_transfer_multi` | Bulk transfers with glob patterns |

### Monitoring
| Tool | Description |
|------|-------------|
| `get_system_resources` | CPU, RAM, Disk metrics |
| `get_services_status` | systemd, Docker, PM2 status (graceful fallback) |
| `get_fail2ban_status` | Fail2Ban status |
| `check_api_health` | HTTP health check |

### Logs
| Tool | Description |
|------|-------------|
| `get_pm2_logs` | PM2 logs |
| `get_docker_logs` | Docker logs |
| `tail_file` | Tail a remote file |

### File Operations (Local + Remote)
| Tool | Description |
|------|-------------|
| `file_read` | Read file + SHA-256 hash (edit protection) |
| `file_write` | Create/overwrite with `dryRun` and `backup` |
| `file_edit` | Surgical or full edit + hash protection |

### Comparison & Drift Detection
| Tool | Description |
|------|-------------|
| `diff_files` | Compare 2 files (local/remote, cross-server) |
| `diff_folders` | Compare 2 directories |
| `compare_all_sources` | Detect drifts across N servers |

### Persistent Shell Sessions
| Tool | Description |
|------|-------------|
| `shell_create` | Open a persistent shell (cd/env preserved) |
| `shell_exec` | Execute in an existing session |
| `shell_list` / `shell_close` | List/close sessions |

### tmux (Surviving Terminal Sessions)
| Tool | Description |
|------|-------------|
| `tmux_create` | Create a persistent tmux session |
| `tmux_exec` | Send a command to a session |
| `tmux_read` | Read session buffer |
| `tmux_list` / `tmux_kill` | List/kill sessions |

### SSH Tunnels
| Tool | Description |
|------|-------------|
| `tunnel_create` | Local/remote/SOCKS5 tunnel, persistent via tmux |
| `tunnel_list` | List active tunnels |
| `tunnel_close` | Close a tunnel |
| `tunnel_allowlist_add/remove` | Manage allowed ports |

### Snapshots (File Versioning)
| Tool | Description |
|------|-------------|
| `snapshot_create` | Capture file state with deduplication |
| `snapshot_list` | List snapshots |
| `snapshot_diff` | Compare 2 snapshots |
| `snapshot_restore` | Restore (dryRun by default) |
| `snapshot_delete` | Delete + orphan cleanup |

### Queue & Monitoring
| Tool | Description |
|------|-------------|
| `task_queue` | View all active/pending tasks |
| `task_status` | Task detail by ID |
| `task_history` | Filterable history |
| `task_retry` | Retry a failed task |
| `task_wait` | Wait for a background task |
| `task_logs` | MCP internal logs |
| `queue_stats` / `pool_stats` | Queue and SSH pool stats |

### API Catalog
| Tool | Description |
|------|-------------|
| `api_add` / `api_list` / `api_remove` | API monitoring catalog |
| `api_check` | Health check via SSH + curl |

---

## 📖 Usage Examples

### Multi-server
```bash
# One command, multiple servers
task_exec {alias:["vps1","vps2","vps3"], cmd:"uptime"}

# Entire fleet
task_exec {alias:"all", cmd:"df -h /"}
```

### SOCKS5 Proxy Tunnel
```bash
tunnel_create {name:"proxy", type:"socks", listen_port:1080, via:"vps_paris"}
# → Browser → SOCKS5 127.0.0.1:1080 → Paris VPS
```

### Local Tunnel (access remote service)
```bash
tunnel_create {name:"crm", type:"local", listen_port:8080, target:"127.0.0.1:3100", via:"vps_prod"}
# → http://localhost:8080 → production CRM
```

### Remote Tunnel (expose local service)
```bash
tunnel_create {name:"dev", type:"remote", listen_port:9090, target:"127.0.0.1:3000", via:"vps", source:"vps_prod", key_path:"/home/user/.ssh/vps.key"}
# → vps_prod:9090 → your local machine:3000
```

### Persistent tmux Session
```bash
tmux_create {alias:"vps", name:"build", start_cmd:"npm run build"}
tmux_read {alias:"vps", session:"build"}
tmux_kill {alias:"vps", session:"build"}
```

### Security Blocklist
```bash
# List blocked commands
policy_blocklist_list
# → ["rm -rf /", "mkfs*", ...]

# Conscious bypass
task_exec {alias:"vps", cmd:"rm -rf /tmp/cache", skip_policy:true}
```

### Secure File Editing
```bash
# Read + hash
file_read {source:{type:"remote", alias:"vps", path:"/etc/nginx/nginx.conf"}}
# → content + hash

# Edit with protection
file_edit {source:{type:"remote", alias:"vps", path:"/etc/nginx/nginx.conf"},
           oldString:"worker_connections 768;",
           newString:"worker_connections 1024;",
           expectedHash:"abc123...",
           backup:true}

# Preview without writing
file_edit {source:{type:"remote", alias:"vps", path:"/etc/nginx/nginx.conf"},
           oldString:"worker_connections 768;",
           newString:"worker_connections 1024;",
           dryRun:true}
```

### Snapshot Before Risky Changes
```bash
# Before
snapshot_create {source:{type:"remote", alias:"vps"}, paths:["/etc/nginx/"], tag:"before-fix"}

# After if something broke
snapshot_restore {snapshotId:"...", target:{type:"remote", alias:"vps"}, dryRun:false, force:true}
```

### Multi-server Drift Detection
```bash
compare_all_sources {sources:[
  {type:"remote", alias:"vps1", path:"/etc/nginx/nginx.conf", label:"prod"},
  {type:"remote", alias:"vps2", path:"/etc/nginx/nginx.conf", label:"staging"}
]}
```

---

## 📚 AI Built-in Manual (guide)

The orchestrator includes an interactive manual for your AI agent:

```bash
guide section:index       # Table of contents
guide section:workflows   # Copy-paste recipes
guide section:cheatsheet  # Tool → usage table
guide section:audit       # Full fleet audit in 8 steps
guide section:security    # Blocklist + tunnels
guide section:pitfalls    # Common mistakes
```

---

## 🏗️ Architecture

```
MCP Client (stdio)
    │
server.js ─── 63 MCP tools registered
    │
    ├── queue.js ─────── Persistent job queue (JSON + backup)
    ├── ssh.js ───────── SSH execution (pool + dedicated connections)
    ├── sftp.js ──────── SFTP transfers (upload/download/multi)
    ├── sshPool.js ───── Persistent SSH connection pool
    ├── servers.js ───── CRUD server aliases
    ├── apis.js ──────── CRUD API catalog
    ├── history.js ───── Task history
    ├── config.js ────── Centralized configuration
    ├── utils.js ─────── Utilities (escapeShellArg)
    ├── fileOps.js ───── File operations (read/write/edit)
    ├── diffEngine.js ── Diff engine (files/dirs/sources)
    ├── compareEngine.js ─ Multi-source comparison
    ├── diffFormatter.js ─ Diff formatting
    ├── sourceAdapter.js ─ Local/remote abstraction
    ├── shellSessions.js ─ Persistent shell sessions
    ├── snapshotManager.js ─ Versioned snapshots
    ├── notes.js ──────── Documented server context
    ├── policies.js ──── Command blocklist
    ├── tunnels.js ────── SSH tunnels (local/remote/SOCKS)
    ├── guide.js ──────── AI built-in manual
    └── diagnose.js ───── Diagnostics
```

### Job Lifecycle

```
pending → running → completed / failed
                      ↓ (on restart)
                    crashed → retry → pending
```

---

## 🔒 Security

- **Command Blocklist** : `rm -rf /`, `mkfs*`, fork bombs, and other destructive commands are blocked by default
- **Conscious bypass** : `skip_policy: true` to force execution
- **Tunnel port allowlist** : only explicitly allowed ports can be used
- **File access restriction** : `MCP_ALLOWED_ROOTS` env var to limit file operations to specific directories
- **`escapeShellArg()`** : all URLs and paths are escaped before being passed to curl/shell
- **Plaintext secret detection** : warning on startup if passwords/API keys are in plaintext
- **Pre-modification snapshots** : `backup:true` on file_edit/file_write for instant rollback
- **Recommendation** : use SSH keys (not passwords), store secrets in Vaultwarden

---

## 🧪 Tests

```bash
node diagnose.js        # Full diagnostic
node test_mcp.js        # MCP smoke test
node test_features.js   # Unit tests (queue, pool, glob, prompts, crash)
```

---

## 🛣️ Roadmap

| Version | Changes |
|---------|---------|
| 10.0.0 | New tools: file_read/write/edit, diff, snapshots, shell, notes |
| 10.4.0 | server_to_server, help with schemas, audit guide |
| 11.0.0 | Command Blocklist, Multi-host (`alias:"all"`), tmux |
| 11.2.0 | SSH Tunnels (local/remote/SOCKS5), allowlist, ssh2 stderr fix |
| 11.3.0 | AllowedRoots (`MCP_ALLOWED_ROOTS`) for file restriction |
| 12.0.0 (planned) | Auto key setup for tunnels, webhooks, static dashboard |

---

## 📄 License

MIT — Copyright (c) 2025-2026 Franck (fkom13)
