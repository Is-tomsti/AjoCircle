import { createServer } from 'node:http';
import { isIP } from 'node:net';

/**
 * Start a loopback-only development HTTP server around an already configured
 * member quote handler. Authentication and trusted repositories must be wired
 * by the caller; this module intentionally provides no fake/default identity.
 */
export async function startMemberQuoteDevServer({ handler, port = 0 } = {}) {
  if (typeof handler !== 'function') throw new Error('A fully configured member quote handler is required');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be an integer between 0 and 65535');

  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      if (response.headersSent || response.writableEnded) {
        response.destroy();
        return;
      }
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      response.setHeader('x-content-type-options', 'nosniff');
      response.end(JSON.stringify({ error: 'INTERNAL_ERROR' }));
    });
  });

  await new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });

  const address = server.address();
  if (!address || typeof address === 'string' || isIP(address.address) !== 4 || address.address !== '127.0.0.1') {
    await new Promise(resolve => server.close(resolve));
    throw new Error('Development server must bind to IPv4 loopback only');
  }
  return server;
}
