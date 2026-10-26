import { handleRequest } from '../src/server.js';

export default async function handler(req, res) {
  const protocol = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const requestUrl = new URL(req.url || '/', `${protocol}://${req.headers.host || 'localhost'}`);
  const requestedPath = requestUrl.searchParams.get('__path');

  if (requestedPath?.startsWith('/')) {
    requestUrl.searchParams.delete('__path');
    req.url = `${requestedPath}${requestUrl.search}`;
  }

  return handleRequest(req, res);
}
