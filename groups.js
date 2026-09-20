/** Groupes d'alias serveurs. Stockage atomique: <dataDir>/server_groups.json */
import path from 'path';
import config from './config.js';
import servers from './servers.js';
import jsonStore from './atomicJsonStore.js';
const GROUPS_PATH = path.join(config.dataDir, 'server_groups.json');
const DEFAULT_GROUPS = { oci:['fkomprodmini1_prod','fkomprodmini2_prod','fkomprodmini2_vpn'], contabo:['vps_contabo'], vpsparfait:['vpsparfait_fkomp','vpsparfait2_fkomp'], local:['pc1_tailscale'] };
const loadGroups = () => jsonStore.readJson(GROUPS_PATH, DEFAULT_GROUPS);
async function listGroups(){ return loadGroups(); }
async function setGroup(name, aliases){
 if(!name || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Nom de groupe invalide (alphanumérique, _ ou -).");
 if(!Array.isArray(aliases)||!aliases.length) throw new Error("aliases doit être un tableau non vide d'alias serveurs.");
 const all=await servers.listServers(); const unknown=aliases.filter(a=>!all[a]); if(unknown.length) throw new Error(`Alias inconnus: ${unknown.join(', ')}. Utilisez server_list.`);
 const unique=[...new Set(aliases)]; await jsonStore.updateJson(GROUPS_PATH,DEFAULT_GROUPS,g=>{g[name]=unique;return g;}); return {success:true,group:name,aliases:unique};
}
async function removeGroup(name){ await jsonStore.updateJson(GROUPS_PATH,DEFAULT_GROUPS,g=>{if(!g[name]) throw new Error(`Groupe '${name}' introuvable.`); delete g[name]; return g;}); return {success:true,message:`Groupe '${name}' supprimé.`}; }
async function resolveAliases(aliasInput){
 const allServers=await servers.listServers(), allKeys=Object.keys(allServers); if(aliasInput==null||aliasInput==='') throw new Error("Alias requis.");
 if(Array.isArray(aliasInput)){ const expanded=[]; for(const a of aliasInput){ if(String(a).startsWith('group:')) expanded.push(...await expandGroup(String(a).slice(6))); else {if(!allServers[a]) throw new Error(`Alias inconnu: ${a}`); expanded.push(a);} } return [...new Set(expanded)]; }
 if(aliasInput==='all') return allKeys; if(String(aliasInput).startsWith('group:')) return expandGroup(String(aliasInput).slice(6));
 if(!allServers[aliasInput]){ const groups=await loadGroups(); if(groups[aliasInput]) return expandGroup(aliasInput); throw new Error(`Alias de serveur '${aliasInput}' est inconnu. Utilisez server_list ou group:<nom>.`); }
 return [aliasInput];
}
async function expandGroup(name){ const groups=await loadGroups(); if(!groups[name]) throw new Error(`Groupe '${name}' introuvable. Groupes: ${Object.keys(groups).join(', ') || '(aucun)'}`); const all=await servers.listServers(); const aliases=groups[name].filter(a=>all[a]); if(!aliases.length) throw new Error(`Groupe '${name}' ne contient aucun alias valide actuellement.`); return aliases; }
export default {listGroups,setGroup,removeGroup,resolveAliases,expandGroup};
