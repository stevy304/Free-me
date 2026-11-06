import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeGateway } from './realtime.gateway';

@Global()
@Module({ imports: [AuthModule], providers: [RealtimeGateway], exports: [RealtimeGateway] })
export class RealtimeModule {}
