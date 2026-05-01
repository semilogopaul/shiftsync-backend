import { Module } from '@nestjs/common';
import { SwapsController } from './swaps.controller';
import { SwapsService } from './swaps.service';
import { SwapsRepository } from './swaps.repository';
import { ShiftsModule } from '../shifts/shifts.module';
import { LocationsModule } from '../locations/locations.module';

@Module({
  imports: [ShiftsModule, LocationsModule],
  controllers: [SwapsController],
  providers: [SwapsService, SwapsRepository],
  exports: [SwapsService, SwapsRepository],
})
export class SwapsModule {}
