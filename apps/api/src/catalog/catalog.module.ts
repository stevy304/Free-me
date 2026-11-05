import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { HomeController } from './home.controller';
import { NextController } from './next.controller';

@Module({ controllers: [CatalogController, HomeController, NextController] })
export class CatalogModule {}
