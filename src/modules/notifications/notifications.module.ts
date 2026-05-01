import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsRepository } from './notifications.repository';
import { UsersModule } from '../users/users.module';
import { ShiftsModule } from '../shifts/shifts.module';
import { LocationsModule } from '../locations/locations.module';
import { CertificationsModule } from '../certifications/certifications.module';

@Module({
  imports: [UsersModule, ShiftsModule, LocationsModule, CertificationsModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsRepository],
  exports: [NotificationsService],
})
export class NotificationsModule {}
