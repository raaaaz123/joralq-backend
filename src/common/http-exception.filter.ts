import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';

/**
 * Every error leaves the API in one shape:
 *   { statusCode, error, message, details?, path, timestamp }
 * Known Postgres errors are mapped to proper HTTP codes; anything else is a 500
 * with no internals leaked.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse() as any;
      if (typeof body === 'string') message = body;
      else if (Array.isArray(body?.message)) {
        message = 'Validation failed';
        details = body.message;
      } else message = body?.message ?? exception.message;
    } else if (isPgError(exception)) {
      if (exception.code === '23505') {
        status = HttpStatus.CONFLICT;
        message = 'Resource already exists';
      } else if (exception.code === '22P02' || exception.code === '23514') {
        status = HttpStatus.BAD_REQUEST;
        message = 'Invalid input';
      } else if (exception.code === '23503') {
        status = HttpStatus.BAD_REQUEST;
        message = 'Referenced resource does not exist';
      }
    }

    if (status >= 500) this.logger.error(exception instanceof Error ? exception.stack : String(exception));

    res.status(status).json({
      statusCode: status,
      error: HttpStatus[status] ?? 'Error',
      message,
      ...(details ? { details } : {}),
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}

function isPgError(e: unknown): e is { code: string } {
  return typeof e === 'object' && e !== null && typeof (e as any).code === 'string' && /^[0-9A-Z]{5}$/.test((e as any).code);
}
