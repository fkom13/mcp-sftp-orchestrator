import path from 'path';
import config from './config.js';
import jsonStore from './atomicJsonStore.js';
const POLICIES_PATH=path.join(config.dataDir,'policies.json');
const DEFAULT_POLICIES={command_blocklist:["rm -rf /","rm -rf /*","mkfs*",":(){:|:&};:","dd if=/dev/zero","> /dev/sda","chmod -R 000 /","mv / /dev/null","wget -O- http://* | sh","curl http://* | sh","eval $(curl","eval $(wget","git clone http://* | sh"]};
const loadPolicies=()=>jsonStore.readJson(POLICIES_PATH,DEFAULT_POLICIES);
function checkCommand(cmd,blocklist){ const c=(cmd||'').trim(); if(!c)return{blocked:false}; for(const pattern of blocklist){ if(!pattern)continue; if(pattern.includes('*')){const r=new RegExp('^'+pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*')+'$','i'); if(r.test(c))return{blocked:true,pattern}; continue;} const e=pattern.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); const r=/\/$/.test(pattern)?new RegExp(e+'(?=$|\\s|\\*)','i'):new RegExp(e,'i'); if(r.test(c))return{blocked:true,pattern}; } return{blocked:false}; }
export default { async list(){return loadPolicies();}, async add(pattern){return jsonStore.updateJson(POLICIES_PATH,DEFAULT_POLICIES,p=>{if(!p.command_blocklist.includes(pattern))p.command_blocklist.push(pattern);return p;});}, async remove(pattern){return jsonStore.updateJson(POLICIES_PATH,DEFAULT_POLICIES,p=>{p.command_blocklist=p.command_blocklist.filter(x=>x!==pattern);return p;});}, async check(cmd){const p=await loadPolicies();return checkCommand(cmd,p.command_blocklist);}, checkCommand };
