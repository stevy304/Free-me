import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { HomeController } from './home.controller';

@Module({ controllers: [CatalogController, HomeController] })
export class CatalogModule {}
