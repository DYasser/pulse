import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip anything not on the DTO, so a client cannot set userId by sending it.
      whitelist: true,
      forbidNonWhitelisted: true,
      // Turn JSON into DTO instances so @IsInt() sees numbers, not strings.
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  // Fail closed. `origin: true` reflects whatever Origin asked, which is the wrong
  // default for a public deployment; an unset CORS_ORIGIN means same-origin only.
  const allowedOrigins = process.env.CORS_ORIGIN?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin: allowedOrigins ?? false,
    credentials: true,
  });

  // Lets Nest run onModuleDestroy, which closes the database pool.
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}

// Without this a bootstrap failure - an unset JWT_SECRET, an unreachable database -
// becomes an unhandled rejection, and the reason is buried in a crash loop.
bootstrap().catch((error: unknown) => {
  new Logger('Bootstrap').error(
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  );
  process.exit(1);
});
