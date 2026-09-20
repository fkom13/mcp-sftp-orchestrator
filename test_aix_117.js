import assert from 'assert';
import { parseProbe, parseNginx, parseDocker, buildDomainGraph } from './infraTopology.js';
import { annotationsFor, DESCRIPTION_OVERRIDES } from './toolMetadata.js';

let passed=0, failed=0;
async function test(name, fn){ try{await fn(); console.log(`  ✅ ${name}`); passed++;}catch(e){console.error(`  ❌ ${name}: ${e.stack||e}`); failed++;} }

const dockerText = [
  'ea-iacapoc-mcp-gateway\tea-iacapoc-mcp-gateway:0.8.0-poc.20\tUp 2h\t127.0.0.1:8790->8787/tcp\tea-iacapoc-mcp\tgateway',
  'api\tmy-api:1\tUp 1h\t0.0.0.0:4000->3000/tcp\tfoo\tapi'
].join('\n');
const nginxText = `# configuration file /etc/nginx/sites-enabled/iaca:\nserver {\n listen 443 ssl;\n server_name chatgpt.esprit-artificiel.com;\n location / { proxy_pass http://127.0.0.1:8790; }\n}\n# configuration file /etc/nginx/conf.d/upstream.conf:\nupstream app_pool {\n server 127.0.0.1:4000;\n}\nserver {\n listen 443 ssl;\n server_name app.example.test;\n location / { proxy_pass http://app_pool; }\n}\n`;

await test('annotations read-only infra_overview',()=>{
  const a=annotationsFor('infra_overview');
  assert.equal(a.readOnlyHint,true); assert.equal(a.destructiveHint,false); assert.equal(a.idempotentHint,true);
});
await test('annotations arbitrary exec remains risky',()=>{
  const a=annotationsFor('task_exec');
  assert.equal(a.readOnlyHint,false); assert.equal(a.destructiveHint,true); assert.equal(a.idempotentHint,false);
});
await test('selection descriptions clarify infra tools',()=>{
  assert.match(DESCRIPTION_OVERRIDES.infra_overview,/domaine/i);
  assert.match(DESCRIPTION_OVERRIDES.server_inventory,/infra_overview/i);
});
await test('docker parser maps host/container ports',()=>{
  const d=parseDocker(dockerText); assert.equal(d.length,2); assert.equal(d[0].portMappings[0].hostPort,8790); assert.equal(d[0].composeProject,'ea-iacapoc-mcp');
});
await test('nginx parser extracts server blocks + upstream',()=>{
  const n=parseNginx(nginxText); assert.equal(n.serverBlocks.length,2); assert.deepEqual(n.upstreams.app_pool.servers,['127.0.0.1:4000']);
});
await test('domain graph resolves direct host port to container',()=>{
  const n=parseNginx(nginxText), d=parseDocker(dockerText), g=buildDomainGraph(n,d);
  const i=g.find(x=>x.domain==='chatgpt.esprit-artificiel.com'); assert.ok(i); assert.equal(i.routes[0].containers[0].container,'ea-iacapoc-mcp-gateway');
});
await test('domain graph resolves named upstream to container',()=>{
  const n=parseNginx(nginxText), d=parseDocker(dockerText), g=buildDomainGraph(n,d);
  const i=g.find(x=>x.domain==='app.example.test'); assert.ok(i); assert.equal(i.routes[0].containers[0].container,'api');
});
await test('full probe parser summarizes topology',()=>{
  const raw=`===META===\nhost1\n2026-08-22T00:00:00Z\n===LISTENERS===\nLISTEN 0 4096 127.0.0.1:8790 0.0.0.0:*\n===DOCKER===\n${dockerText}\n===PM2===\n[]\n===SYSTEMD===\nnginx.service loaded active running nginx\n===NGINX===\n${nginxText}`;
  const p=parseProbe(raw); assert.equal(p.summary.dockerContainers,2); assert.equal(p.summary.domains,2); assert.ok(p.summary.resolvedDomainRoutes>=2);
});

console.log(`\n=== AIX 11.7 Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
