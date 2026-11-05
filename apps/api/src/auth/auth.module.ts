import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AccountsService } from './accounts.service';
import { OtpService } from './otp.service';
import { SessionService } from './session.service';
import { SessionMiddleware } from './session.middleware';
import { GOOGLE_OAUTH, GoogleOAuthClient } from './google.service';

@Module({
  controllers: [AuthController],
  providers: [AccountsService, OtpService, SessionService, { provide: GOOGLE_OAUTH, useClass: GoogleOAuthClient }],
  exports: [SessionService, AccountsService],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer) { consumer.apply(SessionMiddleware).forRoutes('*path'); }
}
