/**
 * Vercel entry point. Every request that is not a file in public/ arrives here.
 */
import { handleRequest } from '../src/app.js';

export default function handler(req, res) {
  return handleRequest(req, res);
}
