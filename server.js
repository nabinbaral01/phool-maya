/**
 * Local server. On Vercel the same handler is served by api/index.js instead.
 */
import { createServer } from 'node:http';
import { handleRequest } from './src/app.js';
import { closeDatabase } from './src/sql.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const server = createServer((req, res) => {
  const started = Date.now();
  res.on('finish', () => {
    if (process.env.LOG_REQUESTS === '1')
      console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
  });
  handleRequest(req, res);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Maya Flora is running');
  console.log(`  Shop   ->  http://localhost:${PORT}`);
  console.log(`  Admin  ->  http://localhost:${PORT}/admin`);
  console.log('');
});

// The embedded local database must be flushed before exit, or its data
// directory is left half-written.
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  await closeDatabase();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, shutdown);
