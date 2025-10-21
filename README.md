# 🚀 MCP SFTP/SSH Orchestrator

Un serveur MCP (Model-Context-Protocol) puissant pour l'orchestration de tâches distantes. Il gère des connexions SSH et SFTP, une file d'attente de tâches persistante, et expose un ensemble riche d'outils pour la gestion de serveurs, le monitoring, et l'exécution de commandes via une interface `stdio` compatible avec les LLM.

✨ **Fonctionnalités Principales**

- **Gestion de Serveurs** : Ajoutez, listez et supprimez des configurations de serveurs SSH/SFTP.
- **Exécution de Tâches SSH** : Simple, interactive, ou en séquence.
- **Transferts de Fichiers SFTP** : Upload/Download de fichiers et dossiers, avec support des patterns `glob`.
- **File d'Attente Intelligente** : Mode hybride (synchrone/asynchrone) et persistance des tâches.
- **Pooling de Connexions** : Gère un pool de connexions SSH pour une exécution ultra-rapide.
- **Outils de Monitoring** : Surveillez les ressources système, le statut des services (systemd, Docker, PM2) et Fail2Ban.
- **Outils de Logs** : Récupérez les logs de PM2, Docker, ou suivez la fin d'un fichier (`tail`).

## 📦 Installation

Ce projet est conçu pour être utilisé comme un outil MCP dans un environnement compatible (comme la `gemini-cli`).

Enregistrez ce MCP auprès de votre client en utilisant la configuration suivante :

```json
{
  "mcpServers": {
    "mcp-sftp-orchestrator": {
      "command": "npx",
      "args": [
        "@fkom13/mcp-sftp-orchestrator"
      ],
      "env": {
        "MCP_DATA_DIR": "~/.config/mcp-orchestrator"
      }
    }
  }
}
```

Le client MCP lancera automatiquement le serveur via `npx` lors de son premier appel.

## 🛠️ Configuration

Le serveur est configurable via des variables d'environnement. Vous pouvez créer un fichier `.env` à la racine du projet si vous l'exécutez localement pour le développement.

- `MCP_DATA_DIR`: Le dossier où seront stockées les données (configurations des serveurs, historique, etc.). Par défaut : `~/.config/mcp-orchestrator`.
- `MCP_SYNC_TIMEOUT_S`: Le délai en secondes avant qu'une tâche longue ne passe en arrière-plan. Par défaut : `30`.

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

## 🤝 Contribution

Les contributions sont les bienvenues ! N'hésitez pas à ouvrir une *Issue* pour signaler un bug ou proposer une fonctionnalité, ou une *Pull Request* pour soumettre des modifications.

## 📄 Licence

Ce projet est sous licence MIT.