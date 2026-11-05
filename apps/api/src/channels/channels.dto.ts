import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CHANNEL_DESCRIPTION_MAX, CHANNEL_NAME_MAX } from '@free-me/shared';

export class CreateChannelDto {
  @ApiProperty({ example: 'uwase.music', description: 'Unique handle, shown as @handle' }) @IsString() @MaxLength(31) handle!: string;
  @ApiProperty({ example: 'Uwase Music' }) @IsString() @MinLength(1) @MaxLength(CHANNEL_NAME_MAX) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(CHANNEL_DESCRIPTION_MAX) description?: string;
  @ApiPropertyOptional({ description: 'ISO 3166-1 alpha-2' }) @IsOptional() @IsString() country?: string;
  @ApiPropertyOptional({ description: 'BCP 47' }) @IsOptional() @IsString() defaultLanguage?: string;
}

export class UpdateChannelDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(CHANNEL_NAME_MAX) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(CHANNEL_DESCRIPTION_MAX) description?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() country?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() defaultLanguage?: string | null;
}
