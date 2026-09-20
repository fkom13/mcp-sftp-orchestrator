/** Regression: mutation pendant saveQueue ne doit jamais perdre son dirty flag. */
import assert from 'assert';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-q-atomic-'));
process.env.MCP_DATA_DIR = tmp;
process.env.MCP_DEBUG = 'false';

// config/queue doivent être importés APRES MCP_DATA_DIR.
const fsObj = (await import('fs/promises')).default;
const originalWriteFile = fsObj.writeFile.bind(fsObj);
let delayedOnce = false;
fsObj.writeFile = async (file, data, ...rest) => {
  if (!delayedOnce && String(file).includes('queue.json.') && String(file).endsWith('.tmp')) {
    delayedOnce = true;
    await new Promise(r => setTimeout(r, 80));
  }
  return originalWriteFile(file, data, ...rest);
};

const queue = (await import(`./queue.js?atomic=${Date.now()}`)).default;
try {
  const job = queue.addJob({ type:'unit_atomic', alias:'none', status:'pending' });
  const firstSave = queue.saveQueue();
  await new Promise(r => setTimeout(r, 20));
  queue.updateJobStatus(job.id, 'completed', { output:'latest-state' });
  await firstSave;

  // Avec l'ancien code isDirty était remis à false ici et ce save ne faisait rien.
  await queue.saveQueue();
  const disk = JSON.parse(await fs.readFile(path.join(tmp, 'queue.json'), 'utf8'));
  assert.strictEqual(disk[job.id].status, 'completed');
  assert.strictEqual(disk[job.id].output, 'latest-state');

  const leftovers = (await fs.readdir(tmp)).filter(x => x.includes('.tmp'));
  assert.deepStrictEqual(leftovers, []);
  console.log('QUEUE_ATOMIC_REVISION_OK');
} finally {
  fsObj.writeFile = originalWriteFile;
  queue.stopAutoSave?.();
  await fs.rm(tmp, { recursive:true, force:true });
}
