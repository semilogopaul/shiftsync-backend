import { Module } from '@nestjs/common';
import { CertificationsController } from './certifications.controller';
import { CertificationsService } from './certifications.service';
import { CertificationsRepository } from './certifications.repository';
import { LocationsModule } from '../locations/locations.module';
import { SkillsModule } from '../skills/skills.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [LocationsModule, SkillsModule, UsersModule],
  controllers: [CertificationsController],
  providers: [CertificationsService, CertificationsRepository],
  exports: [CertificationsService, CertificationsRepository],
})
export class CertificationsModule {}
