import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';

export class CreateSwapRequestDto {
  @ApiProperty({ description: 'The shift the requester wants to swap away' })
  @IsString()
  shiftId!: string;

  @ApiProperty({ description: 'The user the requester wants to swap with (recipient)' })
  @IsString()
  toUserId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  reason?: string;
}

export class RespondToSwapDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  reason?: string;
}

export class CreateDropRequestDto {
  @ApiProperty()
  @IsString()
  shiftId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  reason?: string;
}

export class ManagerDecisionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  reason?: string;
}
