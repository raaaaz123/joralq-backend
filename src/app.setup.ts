import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpExceptionFilter } from './common/http-exception.filter';

/** Shared by main.ts and the e2e tests so both run the same pipeline. */
export function configureApp(app: INestApplication) {
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(',').map((s) => s.trim()).filter(Boolean);
  app.enableCors({ origin: origins, allowedHeaders: ['Authorization', 'Content-Type'] });
}
