import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminController } from './admin.controller';
import { SystemController } from './system.controller';

@Module({ imports: [AuthModule], controllers: [AdminController, SystemController] })
export class AdminModule {}
