import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * Turns anything thrown into a response that says nothing it should not.
 *
 * Without this, a Prisma error reaches the default handler and is logged in full -
 * including, on a constraint violation, the column values that caused it. The
 * client sees a bare 500 either way, but the log is where a stray email address
 * would otherwise end up.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host
      .switchToHttp()
      .getRequest<{ method: string; url: string }>();

    if (exception instanceof HttpException) {
      // Deliberate rejections - 401, 404, a validation 400 - are not incidents.
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    // Anything else is a bug. Log the type and message but not the payload, and
    // tell the client nothing beyond the status.
    const detail =
      exception instanceof Error
        ? `${exception.name}: ${exception.message}`
        : String(exception);

    this.logger.error(`${request.method} ${request.url} failed - ${detail}`);

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}
