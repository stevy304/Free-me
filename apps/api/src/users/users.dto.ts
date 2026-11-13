import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { BIO_MAX, DISPLAY_NAME_MAX } from '@free-me/shared';

export class UpdateProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(DISPLAY_NAME_MAX) displayName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(BIO_MAX) bio?: string;
  @ApiPropertyOptional({ description: 'ISO 3166-1 alpha-2, or null to clear', nullable: true }) @IsOptional() @IsString() country?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(100) city?: string | null;
  @ApiPropertyOptional({ description: 'BCP 47 language' }) @IsOptional() @IsString() preferredLanguage?: string;
  @ApiPropertyOptional({ description: 'IANA time zone, e.g. Africa/Kigali', nullable: true }) @IsOptional() @IsString() @MaxLength(64) timezone?: string | null;
  @ApiPropertyOptional({ description: 'Let "For you" use what I watch and like' }) @IsOptional() @IsBoolean() personalizedRecommendations?: boolean;
}
