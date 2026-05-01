import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsTimeZone,
  Length,
  Max,
  Min,
} from 'class-validator';
import { Role } from '@prisma/client';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Jane' })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  firstName?: string;

  @ApiPropertyOptional({ example: 'Doe' })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  lastName?: string;

  @ApiPropertyOptional({ example: '+1 555 123 4567' })
  @IsOptional()
  @IsString()
  @Length(0, 32)
  phone?: string;

  @ApiPropertyOptional({ example: 'America/Los_Angeles' })
  @IsOptional()
  @IsTimeZone()
  preferredTimezone?: string;
}

export class UpdateNotificationPrefsDto {
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  notifyInApp?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  notifyEmail?: boolean;
}

export class UpdateDesiredHoursDto {
  @ApiProperty({ example: 32, minimum: 0, maximum: 80 })
  @IsInt()
  @Min(0)
  @Max(80)
  @Type(() => Number)
  desiredWeeklyHours!: number;
}

export class AdminCreateUserDto {
  @ApiProperty()
  @IsString()
  @Length(3, 254)
  email!: string;

  @ApiProperty()
  @IsString()
  @Length(8, 128)
  password!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 80)
  firstName!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 80)
  lastName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 32)
  phone?: string;

  @ApiProperty({ enum: Role })
  @IsEnum(Role)
  role!: Role;
}

export class AdminUpdateUserRoleDto {
  @ApiProperty({ enum: Role })
  @IsEnum(Role)
  role!: Role;
}

export class AdminSetActiveDto {
  @ApiProperty()
  @IsBoolean()
  isActive!: boolean;
}

export class ListUsersQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: Role })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

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

/**
 * Light-weight directory query: any authenticated user can call this to find
 * other staff (e.g., to nominate a swap recipient or pick a certification
 * grantee). Returns minimal columns (id, firstName, lastName, email, role)
 * and only ever includes active, non-deleted users.
 *
 * If `locationId` is provided, results are scoped to users currently
 * certified at that location — this is what swap dialogs need.
 */
export class DirectoryQueryDto {
  @ApiPropertyOptional({ enum: Role })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional({ description: 'Scope to users currently certified at this location.' })
  @IsOptional()
  @IsString()
  locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;
}
