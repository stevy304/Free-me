import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { SeriesController } from './series.controller';
import { HomeController } from './home.controller';
import { NextController } from './next.controller';
import { RecommendController } from '../recommend/recommend.controller';

@Module({ controllers: [CatalogController, HomeController, NextController, RecommendController, SeriesController] })
export class CatalogModule {}
