# Roadmap MCP Orchestrator — v8.2.0 → v9.0.0

**Date de début** : 08/06/2026
**Protocole** : chaque étape → implémentation → test → validation → snapshot gencodedoc → rendu de main

---

## Étape 1 : Ménage & Uniformisation (v8.2.0)

**Objectif** : nettoyer le code, aligner les versions, uniformiser les formats de réponse pour conformité MCP totale.

### Tâches
1. **Aligner la version partout**  
   - `package.json` : 8.1.0 → 8.2.0  
   - `server.js` ligne 44 : `"8.0.0"` → `"8.2.0"`  
   - README : mettre à jour les références de version

2. **Uniformiser les retours d'erreur**  
   - Remplacer tous les `"ERREUR: " + e.message` par le format structuré `{ toolName, errorCode, errorMessage }` + `isError: true`  
   - Fichiers concernés : `server.js` (api_add, api_remove, api_check)  
   - Vérifier que TOUS les outils utilisent le même format

3. **Nettoyer les logs de démarrage**  
   - `server.js` lignes 2-33 : mettre les `console.error` d'import derrière `if (DEBUG)`  
   - Ne garder que les logs utiles hors debug

4. **Nettoyer la variable zombie `.env`**  
   - `.env.example` : supprimer `SYNC_TIMEOUT=30000`  
   - `.env` : supprimer `SYNC_TIMEOUT=30000` si présent  
   - Ne garder que `MCP_SYNC_TIMEOUT_S`

5. **Centraliser les handlers SIGINT/SIGTERM**  
   - Garder le handler dans `server.js` (à créer)  
   - Supprimer les handlers dans `queue.js` et `sshPool.js`  
   - Le handler de `server.js` appelle `queue.shutdown()` et `sshPool.closeAll()`

6. **Nettoyer le vestige `conn.isReady`**  
   - `sshPool.js` ligne 104 : supprimer `conn.isReady = true`  
   - `sshPool.js` ligne 245 : remplacer `info?.conn?.isReady` par l'appel à `this.isConnectionReady(connId)`

7. **Vérifier la conformité MCP des réponses**  
   - Toute réponse doit avoir `content: [{ type: "text", text: "..." }]`  
   - Toute erreur doit avoir `isError: true` + un contenu texte structuré

### Validation
- `node diagnose.js` doit passer
- `node test_mcp.js` doit passer
- `node test_features.js` doit passer
- Aucun `console.error` parasite au démarrage sans `MCP_DEBUG=true`

---

## Étape 2 : Transferts SFTP Blindés "façon FileZilla" (v8.3.0)

**Objectif** : corriger le bug dossier/fichier, ajouter la gestion des conflits (force: true), fiabiliser upload ET download.

### Tâches
1. **Corriger `handleDownload` (sftp.js)**  
   - Détecter si `localPath` est un fichier (a une extension OU n'existe pas ET ressemble à un fichier)  
   - Détecter si `localPath` est un dossier (existe déjà en tant que dossier)  
   - Si fichier + pas d'extension explicite → ambigu → erreur claire  
   - Si fichier + existe déjà + pas `force: true` → erreur "fichier existe déjà, utiliser force:true pour écraser"  
   - Si dossier + existe → mettre le(s) fichier(s) dedans avec leur nom d'origine  
   - Si dossier + n'existe pas → le créer puis mettre les fichiers dedans

2. **Corriger `handleUpload` (sftp.js)**  
   - Même logique que download mais côté distant  
   - Vérifier via `sftp.exists()` si le chemin distant existe  
   - Si c'est un dossier existant → mettre dedans  
   - Si c'est un fichier existant + pas `force: true` → erreur  
   - Si n'existe pas → déterminer si c'est un fichier ou dossier selon la source

3. **Ajouter le paramètre `force` aux outils**  
   - `task_transfer` : ajouter `force: z.boolean().optional().default(false)`  
   - `task_transfer_multi` : ajouter `force: z.boolean().optional().default(false)`  
   - Propager `force` dans le job

4. **Tests**  
   - Upload d'un fichier vers un chemin qui n'existe pas → le fichier est créé  
   - Upload d'un fichier vers un dossier existant → le fichier est mis dedans  
   - Upload d'un fichier vers un fichier existant sans `force` → erreur  
   - Upload d'un fichier vers un fichier existant avec `force: true` → écrasement  
   - Download : mêmes 4 scénarios  
   - Transferts multiples avec glob : mêmes comportements

5. **Messages d'erreur clairs**  
   - "Le fichier distant /path/file.txt existe déjà. Utilisez force:true pour l'écraser."  
   - "Le chemin local /path est un dossier existant. Le fichier sera placé dedans."  
   - "Impossible de déterminer si /path est un fichier ou un dossier. Précisez le chemin."

### Validation
- Tests manuels avec un fichier test upload/download
- `node test_features.js` (ajouter les cas de test)

---

## Étape 3 : Résoudre les Timeouts Longues Opérations (v8.4.0)

**Objectif** : permettre les commandes longues (docker build, grosses installs) sans timeout, améliorer le mode arrière-plan.

### Tâches
1. **Ajouter paramètre `timeout` (secondes) à `task_exec`**  
   - `timeout: z.number().optional()` — timeout en secondes  
   - `timeout: 0` = pas de limite (infini)  
   - `timeout` non défini = timeout par défaut (300s)  
   - Propager dans le job → `ssh.js` l'utilise

2. **Augmenter le timeout par défaut**  
   - `config.js` : `defaultCommandTimeout` de 300s → 600s (10 min)  
   - Ajouter une variable d'env `MCP_DEFAULT_CMD_TIMEOUT_S` pour le configurer en secondes

3. **Paramètre `timeout` aussi pour `task_exec_sequence` et `task_exec_interactive`**  
   - Même logique : 0 = infini

4. **Améliorer le mode arrière-plan**  
   - Quand le job passe en arrière-plan (syncTimeout dépassé), le message retourné doit inclure :  
     - L'ID du job (déjà fait)  
     - Le statut actuel  
     - Le timeout estimé  
     - Une instruction pour repoll : "Utilisez task_status avec l'ID xxx pour vérifier l'état"

5. **Augmenter `MCP_SYNC_TIMEOUT_S` par défaut**  
   - De 30s → 120s (2 minutes)  
   - Le client OpenCode a généralement un timeout de ~60-120s, donc 120s est raisonnable

6. **Ajouter `task_wait`** (nouvel outil)  
   - Prend un job ID en paramètre  
   - Attend que le job termine (jusqu'à 10 minutes)  
   - Retourne le résultat final  
   - Permet au client de lancer un job en arrière-plan puis d'attendre explicitement

### Validation
- Lancer une commande `sleep 180` (3 min) avec timeout=0 → doit réussir
- Lancer une commande qui dépasse le syncTimeout → doit passer en arrière-plan
- `task_wait` sur le job en arrière-plan → doit récupérer le résultat

---

## Étape 4 : SSH Interactif Amélioré (v8.5.0)

**Objectif** : mieux détecter les prompts interactifs, permettre des réponses personnalisées, gérer les menus.

### Tâches
1. **Étendre la détection de prompts**  
   - Ajouter les motifs : menus numérotés (`[1]`, `1.`, `1)`), sélections (`Choose`, `Select`, `Pick`), confirmations avancées (`[Y/n]`, `[y/N]`, `(default`)  
   - Améliorer la détection de password prompts

2. **Améliorer le paramètre `responses`**  
   - Permettre de mapper un prompt attendu à une réponse  
   - Exemple : `{ "Do you want to restart services?": "yes", "Which service?": "nginx" }`  
   - Supporter les expressions régulières dans les clés

3. **Mode interactif pas à pas**  
   - Ajouter un paramètre `stepByStep: true` qui renvoie chaque prompt au client  
   - Le client répond via `task_interactive_respond` (nouvel outil)  
   - Permet à l'IA de décider en temps réel

4. **Gérer les timeouts en mode interactif**  
   - Si aucun prompt n'est détecté pendant `interactiveTimeout` secondes → timeout  
   - Paramètre `interactiveTimeout` (défaut : 120s)

### Validation
- Commande `apt upgrade` simulée avec prompt → réponse automatique
- Commande avec menu numéroté → détection et réponse
- Mode pas à pas → le client reçoit le prompt et peut répondre

---

## Étape 5 : Sécurité (v8.6.0)

**Objectif** : corriger les vulnérabilités d'injection et améliorer la gestion des secrets.

### Tâches
1. **Échapper les arguments shell**  
   - Créer une fonction `escapeShellArg()` dans un nouveau fichier `utils.js`  
   - L'utiliser dans `server.js` pour `check_api_health` et `api_check`  
   - L'utiliser dans `get_docker_logs` et `tail_file` pour les chemins

2. **Ajouter une détection de secrets en clair**  
   - Au démarrage, vérifier si `servers.json` contient des `password`  
   - Si oui, logger un warning : "⚠️ Des mots de passe sont stockés en clair dans servers.json. Utilisez des clés SSH ou Vaultwarden."  
   - Idem pour `apis.json` avec `api_key`

3. **Documenter l'intégration Vaultwarden**  
   - Ajouter une section dans le README expliquant comment utiliser Vaultwarden à la place du stockage en clair  
   - Proposer un script de migration

4. **Ajouter un mode "read-only"**  
   - Variable d'env `MCP_READONLY=true` qui empêche toute commande destructive  
   - Bloque : rm, mv, dd, mkfs, shutdown, reboot, etc.  
   - Utile pour les agents IA qui pourraient être trop créatifs

### Validation
- Vérifier que les curl échappent correctement les URLs avec caractères spéciaux
- Vérifier que le warning secrets s'affiche au démarrage
- Vérifier que le mode read-only bloque les commandes dangereuses

---

## Étape 6 : Mode HTTP/SSE (v9.0.0) — ❌ ABANDONNÉ

**Statut** : Cette fonctionnalité a été retirée dans v9.0.0-clean.

**Raison** : Le transport stdio est suffisant pour les cas d'usage actuels. Le mode HTTP/SSE ajoutait une complexité inutile et nécessitait des dépendances supplémentaires. Les longues opérations sont gérées efficacement via task_wait et les rappels.

**Alternative** : Les clients MCP modernes (OpenCode, Claude Desktop) supportent nativement les opérations longues via stdio. Le streaming temps réel n'est pas nécessaire pour l'orchestration SSH/SFTP.

Si le besoin réapparaît, cette fonctionnalité pourra être réimplémentée en restaurant le snapshot v9.0.0-final.

---

## Résumé des versions

| Étape | Version | Durée estimée | Impact |
|-------|---------|---------------|--------|
| 1     | 8.2.0   | 30 min        | Propreté, conformité |
| 2     | 8.3.0   | 1h            | Correction du bug transfert + force |
| 3     | 8.4.0   | 1h30          | Plus de timeouts sur longues opérations |
| 4     | 8.5.0   | 1h            | SSH interactif fiable |
| 5     | 8.6.0   | 30 min        | Sécurité renforcée |
| 6     | 9.0.0   | 30 min        | Nettoyage final, abandon HTTP/SSE |

**Durée totale estimée** : 5-6h de travail effectif

---

## Post-Roadmap : Corrections v9.0.1

**Date** : 19/06/2026

### Bugs corrigés
1. **Injection shell htpasswd** (server.js:240-246)  
   - Les credentials htpasswd n'étaient pas échappés dans les commandes curl  
   - Fix : utilisation de `utils.escapeShellArg()` pour credentials et headers

2. **Vestiges conn.isReady** (sshPool.js:107, 119)  
   - Propriété obsolète encore définie dans les handlers  
   - Fix : suppression complète, la méthode `isConnectionReady()` est utilisée

3. **Documentation incohérente**  
   - README et ROADMAP mentionnaient HTTP/SSE comme implémenté  
   - Fix : clarification que HTTP/SSE a été abandonné en v9.0.0-clean