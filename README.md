# 🚀 MCP Orchestrator - Serveur d`orchestration SSH/SFTP

[![Version](https://img.shields.io/badge/version-8.0.0-blue.svg)](https://github.com/fkom13/mcp-sftp-orchestrator)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)

Un serveur MCP (Model-Context-Protocol) puissant pour l'orchestration de tâches distantes. Il gère des connexions SSH et SFTP, une file d'attente de tâches persistante, et expose un ensemble riche d'outils pour la gestion de serveurs, le monitoring, et l'exécution de commandes via une interface stdio compatible avec les LLM.

## ✨ Fonctionnalités Principales

### 🔐 Gestion de Serveurs
- ✅ Configuration multi-serveurs avec alias
- ✅ Support authentification par clé SSH ou mot de passe
- ✅ Stockage sécurisé des configurations

### 📡 Exécution SSH
- ✅ Commandes simples et séquences
- ✅ Mode interactif avec auto-réponse aux prompts
- ✅ Streaming pour logs (PM2, Docker, tail, journalctl)
- ✅ Pool de connexions persistantes
- ✅ Retry automatique en cas d`échec

### 📁 Transferts SFTP
- ✅ Upload/Download de fichiers et dossiers
- ✅ Support patterns glob (`*.txt`, `**/*.js`)
- ✅ Transferts multiples en une seule commande
- ✅ Création automatique des dossiers parents

### 📊 Monitoring & APIs
- ✅ Monitoring système (CPU, RAM, Disque)
- ✅ Statut des services (systemd, Docker, PM2)
- ✅ Health checks HTTP/HTTPS avec authentification
- ✅ Catalogue d`APIs personnalisable
- ✅ Fail2Ban status

### 🎯 Gestion de Tâches
- ✅ Queue persistante avec sauvegarde automatique
- ✅ Exécution hybride (sync/async)
- ✅ Historique des commandes
- ✅ Retry manuel et automatique
- ✅ Statistiques détaillées

---

## 📦 Installation

Vous avez deux méthodes pour utiliser cet outil :

### Méthode 1 : Via NPM (Recommandé)

C'est la méthode la plus simple. L'outil sera téléchargé et exécuté à la demande par `npx`.

Enregistrez ce MCP auprès de votre client (ex: `gemini-cli`) avec la configuration suivante :

```json
{
  "mcpServers": {
    "orchestrator": {
      "command": "npx",
      "args": [
        "@fkom13/mcp-sftp-orchestrator"
      ],
      "env": {
        "MCP_DATA_DIR": "/chemin/absolu/vers/votre/dossier/de/donnees"
      }
    }
  }
}
```
**Important** : Remplacez `/chemin/absolu/vers/votre/dossier/de/donnees` par un chemin réel sur votre machine, par exemple `~/.config/mcp-orchestrator`.

### Méthode 2 : Depuis les Sources (Git)

Cette méthode est utile si vous souhaitez modifier le code.

1.  **Clonez le dépôt :**
    ```bash
    git clone https://github.com/fkom13/mcp-sftp-orchestrator.git
    cd mcp-sftp-orchestrator
    ```

2.  **Installez les dépendances :**
    ```bash
    npm install
    ```

3.  **Configurez votre client MCP** pour lancer le script localement :
    ```json
    {
      "mcpServers": {
        "orchestrator": {
          "command": "node",
          "args": [
            "/chemin/vers/mcp-sftp-orchestrator/server.js"
          ],
          "env": {
            "MCP_DATA_DIR": "/chemin/vers/mcp-sftp-orchestrator/data"
          }
        }
      }
    }
    ```

---

## 🛠️ Configuration

La configuration du serveur se fait par ordre de priorité :

1.  **Variables d'environnement du client MCP** (le bloc `env` dans votre JSON) : **Priorité la plus haute**. C'est la méthode recommandée pour définir le dossier de données.
2.  **Fichier `.env`** : Si vous lancez le projet localement (méthode 2), vous pouvez créer un fichier `.env` à la racine. Il sera utilisé si la variable n'est pas définie par le client MCP.
3.  **Valeurs par défaut** : Si rien n'est défini, le dossier de données par défaut sera `~/.config/mcp-orchestrator`.

**Variables disponibles :**

- `MCP_DATA_DIR`: (Recommandé) Le dossier où seront stockées les données (configurations des serveurs, historique, etc.).
- `MCP_SYNC_TIMEOUT_S`: Le délai en secondes avant qu'une tâche longue ne passe en arrière-plan. Par défaut : `30`.

---

## 🧰 Référence des Outils (API)

Voici la liste complète des outils exposés par ce serveur MCP.

### Gestion des Serveurs

- `server_add`: Enregistre ou met à jour les informations de connexion d'un serveur.
- `server_list`: Affiche la liste de tous les alias de serveurs configurés.
- `server_remove`: Supprime un alias de serveur de la configuration.

### Exécution de Tâches

- `task_exec`: Exécute une commande SSH (hybride synchrone/asynchrone).
- `task_transfer`: Transfère un fichier ou dossier via SFTP (hybride synchrone/asynchrone).
- `task_exec_interactive`: Exécute une commande SSH interactive (gère les prompts `yes/no`, etc.).
- `task_exec_sequence`: Exécute plusieurs commandes SSH en séquence sur le même serveur.
- `task_transfer_multi`: Transfère plusieurs fichiers/dossiers avec support de patterns `glob`.

### Monitoring & Diagnostics

- `get_system_resources`: Récupère les métriques système vitales (CPU, RAM, Disque).
- `get_services_status`: Récupère le statut des services (systemd, Docker, PM2).
- `get_fail2ban_status`: Récupère les informations du service Fail2Ban.

### Récupération de Logs

- `get_pm2_logs`: Raccourci pour récupérer les logs PM2.
- `get_docker_logs`: Raccourci pour récupérer les logs d'un container Docker.
- `tail_file`: Affiche les dernières lignes d'un fichier distant.

### Gestion de la File d'Attente (Queue)

- `task_queue`: Affiche le statut de toutes les tâches dans la file d'attente.
- `task_status`: Récupère les détails d'une tâche par son ID.
- `task_history`: Affiche l'historique des dernières tâches lancées.
- `task_retry`: Relance une tâche qui a échoué ou crashé.
- `queue_stats`: Affiche les statistiques de la queue de tâches.

### Gestion des APIs (Monitoring Externe)

- `api_add`: Ajoute une API au catalogue de monitoring.
- `api_list`: Affiche toutes les APIs configurées.
- `api_remove`: Supprime une API du catalogue.
- `api_check`: Lance un test de santé sur une API.

### Administration du Serveur MCP

- `task_logs`: Affiche les logs du système MCP lui-même.
- `pool_stats`: Affiche les statistiques du pool de connexions SSH.

---

### Installation rapide

```bash
# Cloner le dépôt
git clone https://github.com/fkom13/mcp-sftp-orchestrator.git
cd mcp-sftp-orchestrator

# Installer les dépendances
npm install

# Copier et configurer l'environnement
cp .env.example .env
nano .env

# Démarrer le serveur
node server.js
```

### ⚙️ Configuration

#### Variables d'environnement (.env)
```bash
# Répertoire de données (configs, historique, queue)
MCP_DATA_DIR="/home/user/.config/mcp-orchestrator"

# Délai avant passage en arrière-plan (secondes)
MCP_SYNC_TIMEOUT_S=30

# Timeouts d'exécution (millisecondes)
MCP_DEFAULT_CMD_TIMEOUT_MS=300000      # 5 minutes
MCP_INTERACTIVE_CMD_TIMEOUT_MS=120000  # 2 minutes

# Pool de connexions SSH
MAX_CONNECTIONS_PER_SERVER=5
MIN_CONNECTIONS_PER_SERVER=1
IDLE_TIMEOUT=300000           # 5 minutes
KEEP_ALIVE_INTERVAL=30000     # 30 secondes

# Queue
MAX_QUEUE_SIZE=1000
SAVE_INTERVAL=5000            # Sauvegarde toutes les 5s
HISTORY_RETENTION=2678400000  # 31 jours

# Debug log wraper erreor in stdio.error
MCP_DEBUG=false
```

#### Structure des données
```text
~/.config/mcp-orchestrator/
├── servers.json      # Configurations serveurs
├── apis.json         # Catalogue d`APIs
├── queue.json        # Queue de tâches
├── queue.backup.json # Backup de sécurité
└── history.json      # Historique
```

---

## 🛠️ Guide d'Utilisation

### 1. Configuration d'un serveur

#### Avec clé SSH
```json
{
  "tool": "server_add",
  "arguments": {
    "alias": "prod_vps",
    "host": "192.168.1.100",
    "user": "admin",
    "keyPath": "/home/user/.ssh/id_rsa"
  }
}
```

#### Avec mot de passe
```json
{
  "tool": "server_add",
  "arguments": {
    "alias": "staging",
    "host": "staging.example.com",
    "user": "deploy",
    "password": "SecureP@ssw0rd"
  }
}
```

### 2. Exécution de commandes

#### Commande simple
```json
{
  "tool": "task_exec",
  "arguments": {
    "alias": "prod_vps",
    "cmd": "uptime && df -h"
  }
}
```

#### Commande interactive
```json
{
  "tool": "task_exec_interactive",
  "arguments": {
    "alias": "prod_vps",
    "cmd": "sudo apt-get update && sudo apt-get upgrade",
    "autoRespond": true,
    "responses": {
      "Do you want to continue": "Y",
      "Restart services": "yes"
    }
  }
}
```

#### Séquence de commandes
```json
{
  "tool": "task_exec_sequence",
  "arguments": {
    "alias": "prod_vps",
    "commands": [
      "cd /var/www/app",
      "git pull origin main",
      "npm install",
      "pm2 restart app"
    ],
    "continueOnError": false
  }
}
```

### 3. Transferts SFTP

#### Upload simple
```json
{
  "tool": "task_transfer",
  "arguments": {
    "alias": "prod_vps",
    "direction": "upload",
    "local": "/home/user/config.json",
    "remote": "/etc/app/config.json"
  }
}
```

#### Transferts multiples avec glob
```json
{
  "tool": "task_transfer_multi",
  "arguments": {
    "alias": "prod_vps",
    "direction": "upload",
    "files": [
      {
        "local": "/home/user/logs/*.log",
        "remote": "/var/log/app/"
      },
      {
        "local": "/home/user/configs/**/*.json",
        "remote": "/etc/app/configs/"
      }
    ]
  }
}
```

### 4. Monitoring

#### Ressources système
```json
{
  "tool": "get_system_resources",
  "arguments": {
    "alias": "prod_vps"
  }
}
```
*Retourne: CPU, RAM, Disque, Load Average*

#### Statut des services
```json
{
  "tool": "get_services_status",
  "arguments": {
    "alias": "prod_vps"
  }
}
```
*Retourne: systemd, Docker, PM2*

#### Logs Docker
```json
{
  "tool": "get_docker_logs",
  "arguments": {
    "alias": "prod_vps",
    "container": "nginx",
    "lines": 100,
    "since": "1h",
    "timestamps": true
  }
}
```

#### Logs PM2
```json
{
  "tool": "get_pm2_logs",
  "arguments": {
    "alias": "prod_vps",
    "app": "api-server",
    "lines": 200,
    "errors": true
  }
}
```

### 5. Catalogue d'APIs

#### Ajouter une API
```json
{
  "tool": "api_add",
  "arguments": {
    "alias": "main_api",
    "url": "https://api.example.com",
    "health_check_endpoint": "/health",
    "health_check_method": "GET",
    "auth_method": "api_key",
    "api_key": "your-api-key-here",
    "auth_header_name": "X-API-Key",
    "auth_scheme": ""
  }
}
```

#### Vérifier une API
```json
{
  "tool": "api_check",
  "arguments": {
    "alias": "main_api",
    "server_alias": "prod_vps"
  }
}
```
*Retourne: status (UP/DOWN), http_code, response_time_ms*

### 6. Gestion de la Queue

#### Voir toutes les tâches
```json
{
  "tool": "task_queue",
  "arguments": {}
}
```

#### Statut d'une tâche
```json
{
  "tool": "task_status",
  "arguments": {
    "id": "a3f8c2d1"
  }
}
```

#### Réessayer une tâche
```json
{
  "tool": "task_retry",
  "arguments": {
    "id": "a3f8c2d1"
  }
}
```

#### Statistiques
```json
{
  "tool": "queue_stats",
  "arguments": {}
}
```
*Retourne: total, byStatus, byType, avgDuration, successRate*

#### Diagnostic complet
```json
{
  "tool": "system_diagnostics",
  "arguments": {
    "verbose": true
  }
}
```

---

## 🏗️ Architecture

### Composants Principaux
```text
┌─────────────────────────────────────────────┐
│           MCP Server (server.js)            │
│  • Enregistrement des tools                 │
│  • Validation des inputs (Zod)              │
│  • Gestion des requêtes/réponses           │
└─────────────┬───────────────────────────────┘
              │
    ┌─────────┴─────────┐
    │                   │
┌───▼────┐       ┌──────▼────────┐
│ SSH    │       │ SFTP          │
│ Module │       │ Module        │
└───┬────┘       └──────┬────────┘
    │                   │
    └─────────┬─────────┘
              │
      ┌───────▼──────────┐
      │  SSH Pool        │
      │  • Connexions    │
      │  • Keep-alive    │
      │  • Auto-cleanup  │
      └───────┬──────────┘
              │
      ┌───────▼──────────┐
      │  Queue Manager   │
      │  • Jobs          │
      │  • History       │
      │  • Persistence   │
      └──────────────────┘
```

### Flux d'Exécution
```text
Client → Tool Call → Validation → Job Creation
                                       ↓
                              Pool Get Connection
                                       ↓
                              Execute (SSH/SFTP)
                                       ↓
                         ┌─────────────┴──────────────┐
                         │                            │
                    Quick Job                    Long Job
                    (< 30s)                      (> 30s)
                         │                            │
                    Sync Return               Async Background
                         │                            │
                    Update Queue              Update Queue
                         │                            │
                    Save History              Save History
```

---

## 📊 Gestion des Erreurs

### Codes d'erreur
| Code                 | Description                      | Action recommandée                          |
|----------------------|----------------------------------|---------------------------------------------|
| `CONNECTION_FAILED`  | Échec de connexion SSH           | Vérifier host/port/réseau                   |
| `AUTH_FAILED`        | Authentification refusée         | Vérifier user/key/password                  |
| `COMMAND_TIMEOUT`    | Commande timeout                 | Augmenter timeout ou vérifier commande      |
| `TRANSFER_FAILED`    | Échec de transfert               | Vérifier chemins et permissions             |
| `QUEUE_FULL`         | Queue saturée                    | Nettoyer ou augmenter `MAX_QUEUE_SIZE`      |
| `RETRY_LIMIT_EXCEEDED`| Max tentatives atteint           | Vérifier la cause et retry manuellement     |

### Exemple de réponse d'erreur
```json
{
  "error": true,
  "code": "CONNECTION_FAILED",
  "message": "Impossible de se connecter au serveur",
  "details": {
    "alias": "prod_vps",
    "host": "192.168.1.100",
    "reason": "ECONNREFUSED"
  },
  "timestamp": "2024-11-14T10:30:45.123Z"
}
```

---

## 🔒 Sécurité

### Bonnes pratiques

#### Clés SSH
- Utilisez des clés plutôt que des mots de passe.
- Protégez vos clés privées (`chmod 600`).
- Utilisez des passphrases.

#### Permissions
- Limitez l'accès au répertoire `MCP_DATA_DIR`.
- Ne commitez jamais `.env` ou les fichiers de données.

#### Réseau
- Utilisez un VPN ou bastion pour l'accès SSH.
- Configurez Fail2Ban sur les serveurs.
- Limitez les IPs autorisées.

#### Mots de passe
- Stockez-les dans des variables d'environnement.
- Utilisez des gestionnaires de secrets (Vault, etc.).

### Fichiers à exclure du versioning
```gitignore
# .gitignore
.env
data/
*.json
!package.json
node_modules/
logs/
*.log
.DS_Store
```

---

## 🧪 Tests

```bash
# Tests unitaires
npm test

# Tests de fonctionnalités
node test_features.js

# Tests de connexion (nécessite un serveur configuré)
npm run test:integration
```

---

## 🐛 Débogage

### Activer les logs verbeux
```bash
# Dans .env
LOG_LEVEL=debug
```

### Consulter les logs système
```json
{
  "tool": "task_logs",
  "arguments": {
    "level": "error",
    "search": "timeout",
    "limit": 100
  }
}
```

### Diagnostic complet
```json
{
  "tool": "system_diagnostics",
  "arguments": {
    "verbose": true
  }
}
```

---

## 🚀 Performance

### Optimisations
- **Pool de connexions**: Réutilisation des connexions SSH.
- **Queue persistante**: Sauvegarde incrémentale toutes les 5s.
- **Cleanup automatique**: Nettoyage des vieilles tâches toutes les heures.
- **Keep-alive**: Maintien des connexions actives.

### Métriques typiques
| Opération             | Temps moyen             |
|-----------------------|-------------------------|
| Commande simple       | 200-500ms               |
| Upload 10MB           | 2-5s                    |
| Download 50MB         | 5-15s                   |
| Pool get connection   | < 50ms (si disponible)  |

---

## 📈 Roadmap
- **v6.0**: Pool de connexions SSH
- **v7.0**: Gestion des prompts interactifs
- **v8.0**: Streaming de logs, amélioration et correction bug path
- **v9.0**: Interface Web de monitoring
- **v10.0**: Support multi-utilisateurs
- **v11.0**: Chiffrement E2E des données sensibles

---

## 🤝 Contribution
Les contributions sont les bienvenues !

1.  Fork le projet
2.  Créez une branche (`git checkout -b feature/amazing`)
3.  Committez (`git commit -m 'Add amazing feature'`)
4.  Push (`git push origin feature/amazing`)
5.  Ouvrez une Pull Request

---

## 📝 Licence
MIT © [Votre Nom]

---

## 💬 Support
- 📧 **Email**: support@example.com
- 🐛 **Issues**: GitHub Issues
- 📖 **Docs**: Documentation complète

---

## 🙏 Remerciements
- Model Context Protocol
- ssh2
- ssh2-sftp-client
