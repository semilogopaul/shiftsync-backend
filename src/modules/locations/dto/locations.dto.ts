import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsTimeZone,
  
  Length,
} from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class CreateLocationDto {
  @ApiProperty({ example: 'Coastal Eats — Pier 39' })
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiProperty({ example: 'America/Los_Angeles' })
  @IsTimeZone()
  timezone!: string;

  @ApiPropertyOptional({ example: '500 The Embarcadero, San Francisco, CA' })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  address?: string;
}

export class UpdateLocationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsTimeZone()
  timezone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AssignManagerDto {
  @ApiProperty({ description: 'User id (must be a MANAGER)' })
  @IsString()
  userId!: string;
}

export class ListLocationsQueryDto extends PaginationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  isActive?: boolean;
}
