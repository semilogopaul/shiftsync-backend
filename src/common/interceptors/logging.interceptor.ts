import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Request } from 'express';
import { Observable, tap } from 'rxjs';

/**
 * Logs every HTTP request after it's been resolved with method, path,
 * status, latency, requestId, and (if present) authenticated user id.
 * Sensitive data (bodies, headers) is intentionally omitted.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();

    const req = ctx.switchToHttp().getRequest<Request & { id?: string; user?: { sub?: string } }>();
    const res = ctx.switchToHttp().getResponse<{ statusCode: number }>();
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.write(req, res.statusCode, startedAt),
        error: () => this.write(req, res.statusCode || 500, startedAt),
      }),
    );
  }

  private write(req: Request & { id?: string; user?: { sub?: string } }, status: number, startedAt: number): void {
    const ms = Date.now() - startedAt;
    const userPart = req.user?.sub ? ` user=${req.user.sub}` : '';
    const idPart = req.id ? ` rid=${req.id}` : '';
    this.logger.log(`${req.method} ${req.originalUrl ?? req.url} ${status} ${ms}ms${userPart}${idPart}`);
  }
}
