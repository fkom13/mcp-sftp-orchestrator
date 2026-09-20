import path from 'path'; import config from './config.js'; import jsonStore from './atomicJsonStore.js';
const HISTORY_FILE_PATH=path.join(config.dataDir,'history.json');
async function logTask(jobDetails){const logEntry={jobId:jobDetails.id,timestamp:new Date().toISOString(),type:jobDetails.type,alias:jobDetails.alias,command:jobDetails.type==='ssh'?jobDetails.cmd:`${jobDetails.direction} ${jobDetails.local} -> ${jobDetails.remote}`}; try{await jsonStore.updateJson(HISTORY_FILE_PATH,[],h=>{h.unshift(logEntry);if(h.length>500)h.length=500;return h;});}catch(error){if(process.env.MCP_DEBUG==='true')console.error(`[ERROR] Failed to write history: ${error.message}`);}}
async function getHistory(filters={}){let h=await jsonStore.readJson(HISTORY_FILE_PATH,[]);if(filters.alias)h=h.filter(x=>x.alias===filters.alias);return h;}
export default {logTask,getHistory};
