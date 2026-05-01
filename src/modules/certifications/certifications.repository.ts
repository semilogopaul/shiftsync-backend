import { Injectable } from '@nestjs/common';
import {
  Certification,
  CertificationSkill,
  Location,
  Prisma,
  Skill,
  User,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export type CertificationWithRelations = Certification & {
  skills: (CertificationSkill & { skill: Skill })[];
  user?: Pick<User, 'id' | 'firstName' | 'lastName' | 'email'> | null;
  location?: Pick<Location, 'id' | 'name' | 'timezone'> | null;
};

@Injectable()
export class CertificationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<CertificationWithRelations | null> {
    return this.prisma.certification.findUnique({
      where: { id },
      include: { skills: { include: { skill: true } } },
    });
  }

  async findByUserAndLocation(
    userId: string,
    locationId: string,
  ): Promise<CertificationWithRelations | null> {
    return this.prisma.certification.findUnique({
      where: { userId_locationId: { userId, locationId } },
      include: { skills: { include: { skill: true } } },
    });
  }

  async findActiveForUserLocation(
    userId: string,
    locationId: string,
  ): Promise<CertificationWithRelations | null> {
    return this.prisma.certification.findFirst({
      where: { userId, locationId, decertifiedAt: null },
      include: { skills: { include: { skill: true } } },
    });
  }

  async listActiveForUser(
    userId: string,
  ): Promise<CertificationWithRelations[]> {
    return this.prisma.certification.findMany({
      where: { userId, decertifiedAt: null },
      include: {
        skills: { include: { skill: true } },
        location: { select: { id: true, name: true, timezone: true } },
      },
      orderBy: { certifiedAt: 'desc' },
    });
  }

  async listForUser(
    userId: string,
    includeHistory: boolean,
  ): Promise<CertificationWithRelations[]> {
    return this.prisma.certification.findMany({
      where: { userId, ...(includeHistory ? {} : { decertifiedAt: null }) },
      include: {
        skills: { include: { skill: true } },
        location: { select: { id: true, name: true, timezone: true } },
      },
      orderBy: { certifiedAt: 'desc' },
    });
  }

  async listForLocation(
    locationId: string,
    includeHistory: boolean,
  ): Promise<CertificationWithRelations[]> {
    return this.prisma.certification.findMany({
      where: { locationId, ...(includeHistory ? {} : { decertifiedAt: null }) },
      include: {
        skills: { include: { skill: true } },
        user: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
      orderBy: { certifiedAt: 'desc' },
    });
  }

  async createWithSkills(input: {
    userId: string;
    locationId: string;
    skillIds: string[];
    expiresAt?: Date;
    notes?: string;
  }): Promise<CertificationWithRelations> {
    return this.prisma.certification.create({
      data: {
        userId: input.userId,
        locationId: input.locationId,
        expiresAt: input.expiresAt,
        notes: input.notes,
        skills: {
          create: input.skillIds.map((skillId) => ({ skillId })),
        },
      },
      include: { skills: { include: { skill: true } } },
    });
  }

  async updateWithSkills(
    id: string,
    patch: {
      expiresAt?: Date | null;
      notes?: string | null;
      skillIds?: string[];
    },
  ): Promise<CertificationWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      if (patch.skillIds) {
        await tx.certificationSkill.deleteMany({
          where: { certificationId: id },
        });
        if (patch.skillIds.length > 0) {
          await tx.certificationSkill.createMany({
            data: patch.skillIds.map((skillId) => ({
              certificationId: id,
              skillId,
            })),
          });
        }
      }
      const data: Prisma.CertificationUpdateInput = {};
      if (patch.expiresAt !== undefined) data.expiresAt = patch.expiresAt;
      if (patch.notes !== undefined) data.notes = patch.notes;
      return tx.certification.update({
        where: { id },
        data,
        include: { skills: { include: { skill: true } } },
      });
    });
  }

  async decertify(id: string, when: Date): Promise<CertificationWithRelations> {
    return this.prisma.certification.update({
      where: { id },
      data: { decertifiedAt: when },
      include: { skills: { include: { skill: true } } },
    });
  }

  async recertify(id: string): Promise<CertificationWithRelations> {
    return this.prisma.certification.update({
      where: { id },
      data: { decertifiedAt: null },
      include: { skills: { include: { skill: true } } },
    });
  }
}
