import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(root, 'web');
const output = resolve(root, 'dist');
if (relative(root, output) !== 'dist') throw new Error('Build destination must be the project dist directory.');
const hash = createHash('sha256');
async function hashFiles(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await hashFiles(path);
    else { hash.update(relative(source, path).replaceAll('\\', '/')); hash.update(await readFile(path)); }
  }
}
await hashFiles(source);
const version = hash.digest('hex').slice(0, 16);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
const sw = await readFile(resolve(output, 'sw.js'), 'utf8');
await writeFile(resolve(output, 'sw.js'), sw.replace("const VERSION = 'development'", `const VERSION = '${version}'`));
console.log(`Static site ready in dist/ (cache ${version}).`);
