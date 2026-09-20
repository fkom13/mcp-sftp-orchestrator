import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import assert from 'assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-mcp-ro-'));
const env = {
  ...process.env,
  MCP_DATA_DIR: dataDir,
  MCP_READONLY: '1',
  MCP_ALLOWED_ROOTS: dataDir,
  MCP_DEBUG: 'false'
};
const transport = new StdioClientTransport({ command: process.execPath, args: ['server.js'], cwd: process.cwd(), env });
const client = new Client({ name: 'orch-hardening-test', version: '1.0.0' });

function text(result) { return (result?.content || []).map(x => x.text || '').join('\n'); }
async function expectReadonly(name, args) {
  const r = await client.callTool({ name, arguments: args });
  assert.strictEqual(r.isError, true, `${name} should return isError`);
  assert.match(text(r), /lecture seule|MCP_READONLY|refus/i, `${name}: ${text(r)}`);
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  console.log('tools=', listed.tools.length);
  assert.strictEqual(listed.tools.length, 82);
  const names = new Set(listed.tools.map(t => t.name));
  for (const n of ['task_transfer','task_transfer_multi','task_exec_interactive','task_exec_sequence','snapshot_restore','api_add','tmux_create','tunnel_create']) assert.ok(names.has(n), n);

  await expectReadonly('task_transfer', { alias:'fake', direction:'upload', local:dataDir+'/a', remote:'/tmp/a' });
  await expectReadonly('task_transfer_multi', { alias:'fake', direction:'upload', files:[{local:dataDir+'/a',remote:'/tmp/a'}] });
  await expectReadonly('task_exec_interactive', { alias:'fake', cmd:'echo ok' });
  await expectReadonly('task_exec_sequence', { alias:'fake', commands:['echo ok'] });
  await expectReadonly('api_add', { alias:'x', url:'https://example.com' });
  await expectReadonly('snapshot_restore', { snapshotId:'none', target:{type:'local'}, dryRun:false, force:true });
  await expectReadonly('tmux_create', { alias:'fake', name:"x'; touch /tmp/nope; #" });
  await expectReadonly('tunnel_create', { name:'x', type:'local', listen_port:8080, target:'127.0.0.1:1', via:'fake' });

  console.log('MCP_HARDENING_INTEGRATION_OK');
} finally {
  await client.close().catch(()=>{});
  await fs.rm(dataDir, { recursive:true, force:true });
}
