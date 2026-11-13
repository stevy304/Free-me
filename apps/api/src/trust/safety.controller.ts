import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsNumber, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import { AuditService } from '../common/audit.service';
import type { AppRequest, AuthContext } from '../common/request';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../database/prisma.service';
import { checkText } from '../safety/check';
import { CATEGORIES, POLICY } from '../safety/policy';
import { BUILT_IN, forgetModeratorTerms, normalise, scoreText } from '../safety/rules';

class TermDto {
  @IsString() @MinLength(2) @MaxLength(80) term!: string;
  @IsString() @MinLength(2) @MaxLength(12) language!: string;
  @IsIn(CATEGORIES) category!: typeof CATEGORIES[number];
  @IsNumber() @Min(0.5) @Max(1) weight!: number;
}
class TryDto { @IsString() @MaxLength(5000) text!: string }

/**
 * Moderators keep the automatic text check up to date (safety/rules.ts): the words, phrases and slang only people
 * who speak the language know, per language and category, and a place to try wording against it.
 */
@ApiTags('moderation')
@Controller('moderation/safety')
@RequireAuth('ADMIN', 'MODERATOR')
export class SafetyController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get()
  @ApiOperation({ summary: 'The categories and their lines, the engine in use, the built-in terms and the terms moderators added' })
  async overview() {
    const terms = await this.prisma.safetyTerm.findMany({ orderBy: [{ language: 'asc' }, { category: 'asc' }, { term: 'asc' }] });
    return {
      engine: this.config.safety.engine, unscannedReview: this.config.safety.unscannedReview,
      categories: CATEGORIES.map((c) => ({ key: c, label: POLICY[c].label, holdFrom: POLICY[c].hold, priority: POLICY[c].priority })),
      builtIn: BUILT_IN.length,
      terms: terms.map((t) => ({ id: t.id, term: t.term, language: t.language, category: t.category, weight: t.weight, createdAt: t.createdAt })),
    };
  }

  @Post('terms')
  @ApiOperation({ summary: 'Add a word or phrase to look for (weight 1: enough alone; under 1: only with another finding)' })
  async add(@Body() b: TermDto, @CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    const term = normalise(b.term);
    if (term.length < 2) throw new BadRequestException('Write at least two letters.');
    const language = b.language.trim().toLowerCase();
    if (!/^([a-z]{2,3}(-[a-z0-9]{2,8})?|any)$/.test(language)) throw new BadRequestException('Use a language code such as rw, fr or en, or "any".');
    const row = await this.prisma.safetyTerm.upsert({ where: { term_language_category: { term, language, category: b.category } }, update: { weight: b.weight },
      create: { term, language, category: b.category, weight: b.weight, createdById: auth.user.id } });
    forgetModeratorTerms();
    await this.audit.record({ userId: auth.user.id, action: 'SAFETY_TERM_ADDED', entityType: 'SafetyTerm', entityId: row.id, req, details: { term, language, category: b.category, weight: b.weight } });
    return { term: row };
  }

  @Delete('terms/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove a word or phrase' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    const r = await this.prisma.safetyTerm.deleteMany({ where: { id } });
    forgetModeratorTerms();
    if (r.count) await this.audit.record({ userId: auth.user.id, action: 'SAFETY_TERM_REMOVED', entityType: 'SafetyTerm', entityId: id, req });
    return { removed: r.count };
  }

  @Post('try')
  @HttpCode(200)
  @ApiOperation({ summary: 'See what the automatic check would do with some text (nothing is saved)' })
  async try(@Body() b: TryDto) {
    const terms = await this.prisma.safetyTerm.findMany({ select: { term: true, category: true, weight: true } });
    const { matches } = scoreText(b.text, terms.map((t) => ({ ...t, category: t.category as typeof CATEGORIES[number] })));
    const d = await checkText(this.prisma, this.config, b.text);
    return { normalised: normalise(b.text), matches, scores: d.scores, hold: d.hold, category: d.category, reason: d.reason };
  }
}
