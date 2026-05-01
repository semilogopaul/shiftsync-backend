import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

interface ErrorResponseBody {
  readonly statusCode: number;
  readonly error: string;
  readonly message: string;
  readonly details?: unknown;
  readonly path: string;
  readonly method: string;
  readonly requestId?: string;
  readonly timestamp: string;
}

/**
 * Global exception filter. Normalises every error into a consistent shape
 * and ensures internal stack traces never leak to API responses.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();

    const { status, error, message, details } = this.normalize(exception);

    const body: ErrorResponseBody = {
      statusCode: status,
      error,
      message,
      ...(details !== undefined ? { details } : {}),
      path: request.url,
      method: request.method,
      requestId: request.id,
      timestamp: new Date().toISOString(),
    };

    if (status >= 500) {
      this.logger.error(
        `[${request.method}] ${request.url} → ${status} ${message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (status >= 400) {
      this.logger.warn(`[${request.method}] ${request.url} → ${status} ${message}`);
    }

    response.status(status).json(body);
  }

  private normalize(exception: unknown): {
    status: number;
    error: string;
    message: string;
    details?: unknown;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();

      // class-validator returns { message: string[] | string, error: string, statusCode: number }
      if (typeof res === 'object' && res !== null) {
        const obj = res as Record<string, unknown>;
        const rawMessage = obj.message;
        const message = Array.isArray(rawMessage)
          ? (rawMessage as string[]).join('; ')
          : typeof rawMessage === 'string'
            ? rawMessage
            : exception.message;

        return {
          status,
          error: typeof obj.error === 'string' ? obj.error : exception.name,
          message,
          details: Array.isArray(rawMessage) ? rawMessage : undefined,
        };
      }

      return {
        status,
        error: exception.name,
        message: typeof res === 'string' ? res : exception.message,
      };
    }

    // Unknown / unhandled: never expose internals
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'InternalServerError',
      message: 'An unexpected error occurred',
    };
  }
}
