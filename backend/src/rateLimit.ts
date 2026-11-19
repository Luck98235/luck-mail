// Simple in-memory per-IP rate limiter (audit #10 L-7).
// Single-user system: this only guards against a stolen session being
// hammered (repeated backup/export downloads, translation quota burn).
// Counts are in-memory and reset on restart; no persistence needed.
import type { Request, Response, NextFunction } from 'express';

export function rateLimit(windowMs: number, max: number, errorMessage: string) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      res.status(429).json({ ok: false, error: errorMessage });
      return;
    }
    arr.push(now);
    hits.set(ip, arr);
    // Bound the map: drop IPs whose window has fully expired.
    if (hits.size > 1000) {
      for (const [k, v] of hits) {
        if (!v.length || now - v[v.length - 1] >= windowMs) hits.delete(k);
      }
    }
    next();
  };
}
