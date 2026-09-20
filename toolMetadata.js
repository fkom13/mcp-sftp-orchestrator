/**
 * Metadata MCP agentique centralisée.
 *
 * L'objectif n'est pas de remplacer les garde-fous serveur par des hints :
 * les annotations MCP aident le client/modèle à choisir et confirmer le bon
 * outil, tandis que les policies/guards restent l'autorité réelle.
 */

const READ_ONLY = new Set([
  'system_diagnostics','server_list','server_group_list','fleet_status','infra_audit',
  'project_list','project_get','project_resolve','project_diff','work_list','server_inventory',
  'policy_blocklist_list','api_list','api_check','get_system_resources','get_services_status',
  'check_api_health','get_fail2ban_status','task_queue','task_status','task_history','pool_stats',
  'queue_stats','task_logs','get_pm2_logs','get_docker_logs','tail_file','help','task_wait',
  'file_read','diff_files','diff_folders','compare_all_sources','shell_list','snapshot_list',
  'snapshot_diff','server_note_get','server_note_list','infra_overview','tmux_read','tmux_list',
  'tunnel_list','guide'
]);

const DESTRUCTIVE = new Set([
  'server_remove','server_group_remove','project_remove','work_end','policy_blocklist_remove',
  'api_remove','task_exec','task_transfer','task_transfer_multi','task_exec_interactive',
  'task_exec_sequence','task_retry','task_retry_all','task_purge','file_write','file_edit',
  'shell_exec','shell_close','snapshot_restore','snapshot_delete','server_note_remove',
  'tmux_exec','tmux_kill','tunnel_close','tunnel_allowlist_remove'
]);

const IDEMPOTENT_MUTATIONS = new Set([
  'server_group_set','project_set','server_note_set','policy_blocklist_add',
  'tunnel_allowlist_add','tunnel_allowlist_remove'
]);

const CLOSED_WORLD = new Set([
  'help','guide','policy_blocklist_list','project_list','project_get','project_resolve',
  'server_group_list','server_note_get','server_note_list','task_queue','task_status',
  'task_history','queue_stats','task_logs','snapshot_list','snapshot_diff'
]);

const DESCRIPTION_OVERRIDES = {
  system_diagnostics: 'Diagnostique le processus MCP lui-même (queue, pool SSH, registres, erreurs). Pour l’état réel d’une machine utilisez server_inventory; pour la topologie domaines→ports→services utilisez infra_overview avec alias.',
  infra_audit: 'Contexte de contrôle-plane en un appel: version Orchestrator, registres, groupes, projets, notes, jobs crashés et pool. N’interroge pas profondément les machines. Pour une machine live et ses routes réseau utilisez infra_overview avec alias.',
  infra_overview: 'Cartographie d’infrastructure. Sans alias: vue légère de tout le parc depuis les registres/notes. Avec alias (ou group:/all): découverte live mise en cache des listeners, Docker/Compose, PM2, systemd et Nginx, puis corrélation domaine → proxy → port → conteneur/service.',
  fleet_status: 'Teste en parallèle la joignabilité SSH et quelques ressources de plusieurs serveurs. Choisir cet outil pour “qui est online ?”. Pour le détail d’une machine utilisez server_inventory; pour ses domaines/services exposés utilisez infra_overview.',
  server_inventory: 'Inventaire live léger d’une machine avec cache TTL: ressources, Docker, PM2, HOME et Tailscale. Ne reconstruit pas les routes reverse-proxy; utilisez infra_overview pour domaine → port → service.',
  task_exec: 'Commande distante one-shot. Pour une commande longue utilisez timeout:0 puis task_wait/task_status. Pour conserver cd/export entre appels utilisez shell_create/shell_exec; pour une session terminal survivant au MCP utilisez tmux_*.',
  task_exec_sequence: 'Exécute plusieurs commandes ordonnées sur le même serveur avec résultat par étape. Préférer à plusieurs task_exec lorsque les étapes sont déterministes mais n’ont pas besoin d’un shell persistant.',
  task_exec_interactive: 'Commande distante avec gestion de prompts interactifs connus. Utiliser seulement si la commande attend réellement yes/no/password/choix; sinon préférer task_exec.',
  task_transfer: 'Transfert fichier ou dossier. server_to_server copie directement source_alias → alias. force:false protège une destination existante. Pour une réplication bit-à-bit avec métadonnées/symlinks, vérifier les warnings du résultat.',
  task_transfer_multi: 'Lot de transferts avec patterns glob. À préférer pour plusieurs fichiers indépendants; task_transfer est plus clair pour un fichier/dossier ou un transfert server_to_server.',
  file_edit: 'Édition chirurgicale locale/remote avec protection expectedHash, dryRun et backup. Préférer à file_write pour modifier un fichier existant sans écraser involontairement des changements concurrents.',
  file_write: 'Crée ou remplace un fichier local/remote. Pour un fichier existant, préférer file_edit + expectedHash quand une édition chirurgicale est possible.',
  shell_create: 'Ouvre un shell SSH persistant: cwd et variables survivent entre shell_exec. Pour une tâche détachée survivant à une déconnexion du MCP, préférer tmux_create/tmux_exec.',
  tmux_create: 'Crée une session tmux distante durable. Adapté aux agents/serveurs de dev et tâches longues que l’on doit reprendre après déconnexion.',
  snapshot_create: 'Snapshot CAS dédupliqué de fichiers/dossiers local ou remote pour rollback infra. Ce n’est pas de la mémoire sémantique projet; GenCodeDoc reste la brique Project Intelligence.',
  help: 'Référence compacte des tools et variables Orchestrator. Pour des workflows agentiques guidés, utiliser guide.',
  guide: 'Playbooks agentiques Orchestrator (audit, déploiement, recovery, transferts). Utiliser help pour le schéma/description d’un tool précis.'
};

function annotationsFor(name) {
  const readOnlyHint = READ_ONLY.has(name);
  return {
    readOnlyHint,
    destructiveHint: readOnlyHint ? false : DESTRUCTIVE.has(name),
    idempotentHint: readOnlyHint || IDEMPOTENT_MUTATIONS.has(name),
    openWorldHint: !CLOSED_WORLD.has(name)
  };
}

function enhanceToolConfig(name, config = {}) {
  const annotations = { ...annotationsFor(name), ...(config.annotations || {}) };
  const description = DESCRIPTION_OVERRIDES[name] || config.description;
  return { ...config, description, annotations };
}

export { annotationsFor, enhanceToolConfig, DESCRIPTION_OVERRIDES };
export default { annotationsFor, enhanceToolConfig, DESCRIPTION_OVERRIDES };
