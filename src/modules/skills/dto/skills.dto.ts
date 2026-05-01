import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class CreateSkillDto {
  @ApiProperty({ example: 'bartender' })
  @IsString()
  @Length(1, 64)
  name!: string;
}

export class UpdateSkillDto {
  @ApiProperty({ example: 'bar lead' })
  @IsString()
  @Length(1, 64)
  name!: string;
}

export class ListSkillsQueryDto extends PaginationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;
}
