import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readKit } from '../src/kit.mjs';

const manifest = JSON.parse(readKit('manifest.json'));
if (manifest.count !== manifest.files.length) throw new Error('Kit manifest count does not match its entries.');
for (const entry of manifest.files) {
  const content = readKit(entry.path);
  if (content.length !== entry.bytes || createHash('sha256').update(content).digest('hex') !== entry.sha256) {
    throw new Error(`Kit file differs from manifest: ${entry.path}`);
  }
}

for (const directory of ['src', 'public', 'tests', 'scripts']) {
  for (const filename of readdirSync(new URL(`../${directory}/`, import.meta.url)).filter(name => name.endsWith('.mjs'))) {
    const file = new URL(`../${directory}/${filename}`, import.meta.url);
    const result = spawnSync(process.execPath, ['--check', file.pathname.split('/').map(decodeURIComponent).join('/')], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
if (!readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').includes('/app.mjs')) throw new Error('Missing workspace entry.');
console.log(`Verified JS syntax and ${manifest.count} original kit files.`);
