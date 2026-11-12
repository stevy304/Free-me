import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { storageProvider } from '../media/queue';
import { ImagesController } from './images.controller';
import { MeController } from './me.controller';

@Module({ imports: [AuthModule], controllers: [MeController, ImagesController], providers: [storageProvider] })
export class UsersModule {}
