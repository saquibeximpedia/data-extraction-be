import { Request } from 'express';

const LOOPBACK = new Set(['127.0.0.1', '::1']);

function normalizeIp(raw: string): string {
  const ip = raw.trim().toLowerCase();
  return ip.startsWith('::ffff:') ? ip.substring(7) : ip;
}

/**
 * The caller's IP. Proxy headers (x-forwarded-for, x-real-ip) are only trusted
 * when the request comes from this machine (e.g. a local reverse proxy);
 * anyone else could set them to 127.0.0.1 and walk past the allow-list.
 */
export function getClientIp(req: Request): string {
  const socketIp = normalizeIp(req.socket?.remoteAddress || req.ip || '127.0.0.1');
  if (!LOOPBACK.has(socketIp)) return socketIp;

  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (first) return normalizeIp(first.split(',')[0]);

  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp) return normalizeIp(realIp);
  return socketIp;
}

/** Empty list or "*" allows everyone; loopback addresses count as one another */
export function isIpAllowed(ip: string, allowList: string[]): boolean {
  if (allowList.length === 0 || allowList.includes('*')) return true;
  const loopbackNames = ['127.0.0.1', '::1', 'localhost'];
  return allowList.some((allowed) => {
    const a = normalizeIp(allowed);
    return a === ip || (loopbackNames.includes(a) && LOOPBACK.has(ip));
  });
}
