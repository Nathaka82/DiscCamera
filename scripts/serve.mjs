import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const root = resolve(fileURLToPath(new URL('../', import.meta.url)), arg('dir', 'web'));
const port = Number(arg('port', '4173'));
const host = arg('host', '0.0.0.0');
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/Donut_Camera') { response.writeHead(301, { Location: '/Donut_Camera/' }); response.end(); return; }
    // Exercise GitHub Pages project paths using the same static output.
    if (pathname.startsWith('/Donut_Camera/')) pathname = pathname.slice('/Donut_Camera'.length);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const path = resolve(root, `.${pathname}`);
    if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) throw new Error('Not found');
    response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(await readFile(path));
  } catch { response.writeHead(404); response.end('Not found'); }
});
server.listen(port, host, () => {
  console.log(`Listening on http://${host}:${port}/`);
  if (host === '0.0.0.0') console.log(`Local preview: http://127.0.0.1:${port}/`);
});
