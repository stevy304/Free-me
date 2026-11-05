import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { REPORT_REASONS } from '@free-me/shared';
import { APP_CONFIG, type AppConfig } from '../config/config';

@ApiTags('site')
@Controller('site')
export class SiteController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get()
  @ApiOperation({ summary: 'Public facts about the service: who runs it, how to reach them, report reasons' })
  site() {
    const l = this.config.legal;
    return {
      operatorName: l.operatorName, contactEmail: l.contactEmail, copyrightEmail: l.copyrightEmail ?? l.contactEmail,
      postalAddress: l.postalAddress, jurisdiction: l.jurisdiction, reportReasons: REPORT_REASONS,
    };
  }
}
