import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, MaxLength } from 'class-validator';

export class RequestCodeDto {
  @ApiProperty({ example: 'aline@example.com' }) @IsString() @MaxLength(254) email!: string;
}

export class VerifyCodeDto {
  @ApiProperty({ example: 'aline@example.com' }) @IsString() @MaxLength(254) email!: string;
  @ApiProperty({ example: '123456', description: 'The 6-digit code from the email' }) @IsString() @Length(6, 6) code!: string;
}
