import { createServer } from 'node:http';
import { readConfig } from './config.js';
import { createHandler } from './server.js';
import { JsonFileTokenStore } from './store.js';

const config = readConfig();
const store = new JsonFileTokenStore(process.env.TOKEN_FILE ?? '.hubspot-tokens.json');
const handle = createHandler({ config, store, fetchImpl: fetch, nowMs: () => Date.now() });

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(req.headers)) headers[name] = Array.isArray(value) ? value.join(',') : value;
    handle({ method: req.method ?? 'GET', url: req.url ?? '/', headers, body: Buffer.concat(chunks).toString('utf8') })
      .then((response) => {
        res.writeHead(response.status, response.headers);
        res.end(response.body);
      })
      .catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"internal_error"}');
      });
  });
}).listen(Number(process.env.PORT ?? 3000), () => {
  console.log(`looot for HubSpot backend listening on port ${process.env.PORT ?? 3000}`);
});
