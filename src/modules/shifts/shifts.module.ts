import { Module } from '@nestjs/common';
import { ShiftsController } from './shifts.controller';
import { ShiftsService } from './shifts.service';
import { ShiftsRepository } from './shifts.repository';
import { ShiftValidatorService } from './validation/shift-validator.service';
import { UsersModule } from '../users/users.module';
import { LocationsModule } from '../locations/locations.module';
import { SkillsModule } from '../skills/skills.module';
import { CertificationsModule } from '../certifications/certifications.module';
import { AvailabilityModule } from '../availability/availability.module';

@Module({
  imports: [UsersModule, LocationsModule, SkillsModule, CertificationsModule, AvailabilityModule],
  controllers: [ShiftsController],
  providers: [ShiftsService, ShiftsRepository, ShiftValidatorService],
  exports: [ShiftsService, ShiftsRepository, ShiftValidatorService],
})
export class ShiftsModule {}
