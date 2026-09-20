import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Serve tests/fixtures over http://127.0.0.1:<port> (content scripts skip file:// by default). */
export async function startFixtureServer() {
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
      const rel = normalize(pathname === '/' ? '/testpage.html' : pathname).replace(/^(\.\.[/\\])+/, '');
      const body = await readFile(join(here, rel));
      const type = rel.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : rel.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : 'text/plain; charset=utf-8';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    } catch (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    url: (path = '/testpage.html') => `http://127.0.0.1:${port}${path}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      })
  };
}
