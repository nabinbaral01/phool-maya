/**
 * Vercel entry point. Every request that is not a file in public/ arrives here.
 */
import { handleRequest } from '../src/app.js';

export default function handler(req, res) {
  // vercel.json rewrites everything to /api?__route=/<original path>, because the
  // function otherwise sees only "/api" as req.url and every route would miss.
  const url = new URL(req.url, 'http://localhost');
  const route = url.searchParams.get('__route');
  if (route !== null) {
    url.searchParams.delete('__route');
    const path = route.startsWith('/') ? route : '/' + route;
    req.url = path + url.search;
  }
  return handleRequest(req, res);
}
