import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import type { AppConfig } from './config/config';

/** Builds the HTTP application (used by main.ts and by the API tests). Every route lives under /api. */
export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config));
  return configureApp(app, config);
}

/** HTTP settings shared by the server and the tests. */
export function configureApp(app: NestExpressApplication, config: AppConfig): NestExpressApplication {
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  if (config.docsEnabled) {
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Free Me API').setDescription('REST API of the Free Me video platform.').setVersion('0.1.0').addCookieAuth('fm_session').build());
    SwaggerModule.setup('api/docs', app, doc, { jsonDocumentUrl: 'api/openapi.json' });
  }
  return app;
}
