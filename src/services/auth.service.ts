import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface SessionPayload {
  ip: string;
  issuedAt: string;
}

/** Password check and signed session tokens */
export const authService = {
  /** Constant-time comparison so response timing doesn't leak the password */
  checkPassword(candidate: string): boolean {
    const a = crypto.createHash('sha256').update(candidate).digest();
    const b = crypto.createHash('sha256').update(env.API_PASSWORD).digest();
    return crypto.timingSafeEqual(a, b);
  },

  issueToken(ip: string): string {
    const payload: SessionPayload = { ip, issuedAt: new Date().toISOString() };
    return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.TOKEN_EXPIRY as jwt.SignOptions['expiresIn'] });
  },

  /** Throws if the token is invalid or expired */
  verifyToken(token: string): SessionPayload {
    return jwt.verify(token, env.JWT_SECRET) as SessionPayload;
  },
};
