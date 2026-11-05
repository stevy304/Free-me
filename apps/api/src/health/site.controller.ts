import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { REPORT_REASONS } from '@free-me/shared';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../database/prisma.service';
import { PUBLIC_VIDEO } from '../catalog/serialize';

@ApiTags('site')
@Controller('site')
export class SiteController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig, private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Public facts about the service: who runs it, how to reach them, report reasons' })
  site() {
    const l = this.config.legal;
    return {
      operatorName: l.operatorName, contactEmail: l.contactEmail, copyrightEmail: l.copyrightEmail ?? l.contactEmail,
      postalAddress: l.postalAddress, jurisdiction: l.jurisdiction, reportReasons: REPORT_REASONS,
    };
  }

  @Get('sitemap')
  @ApiOperation({ summary: 'What search engines may list: public videos (newest 20,000) and Spaces with public videos' })
  async sitemap() {
    const [videos, channels] = await Promise.all([
      this.prisma.video.findMany({ where: PUBLIC_VIDEO, orderBy: { publishedAt: 'desc' }, take: 20_000, select: { id: true, updatedAt: true, isShort: true } }),
      this.prisma.channel.findMany({ where: { videos: { some: PUBLIC_VIDEO } }, orderBy: { subscriberCount: 'desc' }, take: 5_000, select: { handle: true, updatedAt: true } }),
    ]);
    return { videos, channels };
  }
}
