import { Module } from '@nestjs/common';
import { ClockController } from './clock.controller';
import { ClockService } from './clock.service';
import { ClockRepository } from './clock.repository';
import { ShiftsModule } from '../shifts/shifts.module';
import { LocationsModule } from '../locations/locations.module';

@Module({
  imports: [ShiftsModule, LocationsModule],
  controllers: [ClockController],
  providers: [ClockService, ClockRepository],
  exports: [ClockService, ClockRepository],
})
export class ClockModule {}
