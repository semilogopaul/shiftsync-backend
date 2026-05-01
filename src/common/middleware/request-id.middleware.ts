import { randomUUID } from 'node:crypto';
import { NestMiddleware, Injectable } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * Attaches a stable per-request correlation id (`req.id`) and emits it via
 * the `x-request-id` response header. Falls back to inbound header if the
 * caller already sent one (useful for tracing across services).
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request & { id?: string }, res: Response, next: NextFunction): void {
    const inbound = req.header('x-request-id');
    const id = inbound && inbound.length > 0 && inbound.length <= 128 ? inbound : randomUUID();
    req.id = id;
    res.setHeader('x-request-id', id);
    next();
  }
}
