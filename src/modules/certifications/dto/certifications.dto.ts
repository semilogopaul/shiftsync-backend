import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  
  Length,
} from 'class-validator';

export class GrantCertificationDto {
  @ApiProperty({ description: 'User to certify' })
  @IsString()
  userId!: string;

  @ApiProperty({ description: 'Location for which the user is being certified' })
  @IsString()
  locationId!: string;

  @ApiProperty({ description: 'Skill ids the user is certified for at this location', type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  skillIds!: string[];

  @ApiPropertyOptional({ example: '2026-12-31T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  notes?: string;
}

export class UpdateCertificationDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  skillIds?: string[];

  @ApiPropertyOptional({ description: 'Pass null to clear', nullable: true })
  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  notes?: string | null;
}

export class CertificationsListQueryDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  includeHistory?: boolean;
}
