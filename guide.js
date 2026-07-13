/**
 * guide — Manuel intégré pour l'IA pilote d'orchestrator.
 *
 * Retourne des sections structurées (workflows, cheatsheet, pièges) pour que
 * l'agent charge les bonnes pratiques en début de session, sans avoir à
 * connaître les ~44 outils par cœur. Inspiré de gencodedoc_guide.
 */

const SECTIONS = {
    index: `# Guide Orchestrator — Index

Serveur MCP d'orchestration d'infrastructure (SSH/SFTP, fichiers, diff, sessions, snapshots).

## Catégories d'outils
- **Serveurs** : server_add/list/remove, server_note_* (contexte du parc), infra_overview
- **Exécution** : task_exec (one-shot), task_exec_sequence, shell_* (sessions persistantes)
- **Fichiers** : file_read, file_write, file_edit (local + remote unifiés)
- **Comparaison** : diff_files, diff_folders, compare_all_sources
- **Versioning** : snapshot_create/list/diff/restore/delete
- **Monitoring** : get_system_resources, get_services_status, get_pm2_logs, get_docker_logs, tail_file
- **Transferts** : task_transfer, task_transfer_multi

## Sections détaillées (guide section:<nom>)
- workflows       : recettes copier-coller
- file-editing    : éditer un fichier en sécurité
- sources         : concept local vs remote
- cheatsheet      : tableau outil → usage
- audit           : audit complet du parc (recette copier-coller)
- security        : politique de sécurité (blocklist + tunnels)
- pitfalls        : pièges à éviter

Astuce : appelle 'infra_overview' en début de session pour situer le parc.`,

    sources: `# Concept clé : les "sources" (local vs remote)

Tous les outils fichiers/diff/snapshot acceptent une source unifiée :

  { type: 'local',  path: '/chemin' }                    → PC hôte du MCP, SANS SSH
  { type: 'remote', alias: 'vpsparfait', path: '/chemin' } → serveur distant via SFTP (pool SSH)

- 'local'  = agit sur la machine où tourne le MCP (fs direct, rapide)
- 'remote' = agit sur un serveur configuré (server_list pour les alias)
- label optionnel : nom lisible pour un affichage clair quand les chemins varient

Puissance : on peut mixer (diff local↔remote, snapshot remote→restore local).`,

    'file-editing': `# Éditer un fichier en sécurité

## Workflow recommandé
1. file_read { source }                 → récupère 'content' + 'hash'
2. file_edit { source, oldString, newString, expectedHash: <hash> }
   - mode chirurgical : remplace un bout précis (économe en tokens)
   - expectedHash : refuse l'édition si le fichier a changé entre-temps (HASH_MISMATCH)

## Options utiles
- dryRun:true  → prévisualise le diff SANS écrire (valider avant d'appliquer)
- backup:true  → snapshot auto avant modif → undo via snapshot_restore
- replaceAll:true → remplace toutes les occurrences (sinon erreur si multiples)

## Mode complet
file_edit { source, newContent: "<tout le fichier>" } → remplace tout.

## Erreurs
- OLDSTRING_NOT_FOUND : le texte exact n'existe pas (vérifie espaces/indentation)
- MULTIPLE_MATCHES    : oldString présent N fois → ajoute du contexte ou replaceAll
- HASH_MISMATCH       : fichier modifié depuis la lecture → relire, réanalyser`,

    workflows: `# Recettes

## Éditer une config distante en sécurité
file_read {source:{type:'remote',alias:'vpsparfait',path:'/etc/nginx/nginx.conf'}}
→ file_edit {source, oldString:'...', newString:'...', expectedHash, backup:true}

## Détecter un drift de config sur le parc
compare_all_sources { sources:[
  {type:'local', path:'/ref.conf', label:'ref'},
  {type:'remote', alias:'vps1', path:'/etc/x.conf', label:'vps1'},
  {type:'remote', alias:'vps2', path:'/etc/x.conf', label:'vps2'}
]}
→ drift:true + diff référence→divergences

## Workflow multi-étapes avec état (build)
shell_create {alias:'vps1', workdir:'/app'} → sessionId
shell_exec {sessionId, command:'npm install'}   # cd/env persistent
shell_exec {sessionId, command:'npm run build'}
shell_close {sessionId}

## Sécuriser avant une modif risquée
snapshot_create {source:{type:'remote',alias:'vps1'}, paths:['/etc/nginx/'], tag:'before-fix'}
... modifs ...
snapshot_restore {snapshotId, target:{type:'remote',alias:'vps1'}, dryRun:true}  # preview
snapshot_restore {snapshotId, target:{type:'remote',alias:'vps1'}, dryRun:false, force:true}`,

    cheatsheet: `# Cheatsheet

| Besoin | Outil |
|--------|-------|
| Lire un fichier | file_read |
| Modifier un bout précis | file_edit (oldString/newString) |
| Créer/écraser | file_write |
| Comparer 2 fichiers | diff_files |
| Comparer 2 dossiers | diff_folders |
| Vérifier cohérence parc | compare_all_sources |
| Commande one-shot | task_exec |
| Suite de commandes avec état | shell_create + shell_exec |
| Sauvegarder avant modif | snapshot_create / backup:true |
| Annuler une modif | snapshot_restore |
| Contexte d'un serveur | server_note_get |
| Vue du parc | infra_overview |
| CPU/RAM/Disque | get_system_resources |
| Logs PM2/Docker | get_pm2_logs / get_docker_logs |`,

    audit: `# Audit complet du parc — recette copier-coller

## 1. Vue d'ensemble
\`\`\`
infra_overview  → liste des serveurs + rôles + services + warnings
\`\`\`

## 2. Ressources de chaque serveur
\`\`\`
get_system_resources {alias:'vps_contabo'}
get_system_resources {alias:'vpsparfait_fkomp'}
get_system_resources {alias:'vpsparfait2_fkomp'}
get_system_resources {alias:'fkomprodmini1_prod'}
get_system_resources {alias:'fkomprodmini2_prod'}
get_system_resources {alias:'pc2'}
\`\`\`

## 3. Services (systemd, Docker, PM2) par serveur
\`\`\`
get_services_status {alias:'vps_contabo'}
# ... idem pour chaque alias
\`\`\`

## 4. Scan Nginx (domaines et proxy_pass)
\`\`\`
task_exec {alias:'<alias>', cmd: "for f in /etc/nginx/sites-enabled/*; do echo \"--- \$f ---\"; cat \"\$f\" 2>/dev/null | grep -E \"server_name|listen|proxy_pass|return \" | head -20; done"}
\`\`\`

## 5. Ports ouverts
\`\`\`
task_exec {alias:'<alias>', cmd: "ss -tlnp 2>/dev/null | sort -n -k4"}
\`\`\`

## 6. Contexte enregistré
\`\`\`
server_note_get {alias:'<alias>'}  → avant d'intervenir sur un serveur
\`\`\`

## 7. Notes de tout le parc
\`\`\`
server_note_list
\`\`\`

## 8. Après une modification risquée, vérifier les drifts
\`\`\`
compare_all_sources {sources: [
  {type:'remote', alias:'vps1', path:'/etc/nginx/nginx.conf', label:'vps1'},
  {type:'remote', alias:'vps2', path:'/etc/nginx/nginx.conf', label:'vps2'}
]}
\`\`\`

Astuce: lancer les appels des étapes 2-5 en parallèle pour un audit complet en ~30s.`,

    security: `# Politique de sécurité

## Command Blocklist
Les commandes dangereuses sont bloquées par défaut avant exécution SSH.

## Gérer la blocklist
\`\`\`
policy_blocklist_list                          → lister les patterns
policy_blocklist_add {pattern:"rm -rf /"}     → ajouter un pattern
policy_blocklist_remove {pattern:"rm -rf /"}  → retirer un pattern
\`\`\`

## Contournement conscient
\`\`\`
task_exec {alias:"vps", cmd:"...", skip_policy:true}
\`\`\`

## Patterns supportés
- Littéral : "rm -rf /" bloque exactement cette commande
- Wildcard : "wget * | sh" bloque tout wget pipé vers sh
- Les patterns sont testés en regex insensible à la casse

La blocklist est stockée dans data/policies.json et persiste entre les redémarrages.

## Tunnels SSH
\`\`\`
tunnel_create {name:"crm", type:"local", listen_port:8080, target:"127.0.0.1:3100", via:"vps_contabo"}
  → http://localhost:8080 → vps_contabo:3100

tunnel_create {name:"proxy", type:"socks", listen_port:1080, via:"vpsparfait"}
  → Proxy SOCKS5 sur localhost:1080 via vpsparfait

tunnel_create {name:"reverse", type:"remote", listen_port:9090, target:"127.0.0.1:3000", via:"vps_contabo", source:"fkomprodmini2"}
  → fkomprodmini2:9090 → localhost:3000 (reverse)
\`\`\`

## Allowlist de ports
Seuls les ports autorisés peuvent être utilisés pour les tunnels.
\`\`\`
tunnel_allowlist_add {port:3306}     → ouvrir un port
tunnel_allowlist_remove {port:3306}  → le fermer
tunnel_list                           → voir les ports autorisés
\`\`\`

## Sécurité des tunnels
- Ports < 1024 bloqués (root requis)
- Allowlist obligatoire : un port doit être explicitement autorisé
- Les tunnels via tmux survivent au redémarrage du MCP
- Les tunnels locaux (source=null) meurent avec le MCP et sont auto-restaurés au redémarrage
- Warning émis à la création`,

    pitfalls: `# Pièges à éviter

1. **Toujours dryRun avant snapshot_restore réel** (écrase des fichiers).
2. **expectedHash sur file_edit** : sans lui, pas de protection contre écrasement concurrent.
3. **type:'local' agit sur l'hôte du MCP**, pas sur un serveur — vérifie bien le type.
4. **Gros fichiers** : file_read avec offset/limit pour consulter sans tout charger.
5. **Binaires** : détection auto (base64), mais file_edit ne s'applique qu'au texte.
6. **shell_exec** : une commande à la fois par session ; ferme les sessions (shell_close).
7. **task_exec ≠ shell_exec** : task_exec isole chaque commande (cd perdu), shell_exec persiste.
8. **Consulte server_note_get avant d'intervenir** sur un serveur inconnu.`
};

export default {
    get(section = 'index') {
        return SECTIONS[section] || `Section '${section}' inconnue. Sections : ${Object.keys(SECTIONS).join(', ')}.`;
    },
    sections() {
        return Object.keys(SECTIONS);
    }
};
