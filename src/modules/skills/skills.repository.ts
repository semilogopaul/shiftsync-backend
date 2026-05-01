import { Injectable } from '@nestjs/common';
import { Prisma, Skill } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class SkillsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Skill | null> {
    return this.prisma.skill.findUnique({ where: { id } });
  }

  async findByName(name: string): Promise<Skill | null> {
    return this.prisma.skill.findUnique({ where: { name } });
  }

  async findManyByIds(ids: string[]): Promise<Skill[]> {
    if (ids.length === 0) return [];
    return this.prisma.skill.findMany({ where: { id: { in: ids } } });
  }

  async createOne(data: Prisma.SkillCreateInput): Promise<Skill> {
    return this.prisma.skill.create({ data });
  }

  async updateById(id: string, data: Prisma.SkillUpdateInput): Promise<Skill> {
    return this.prisma.skill.update({ where: { id }, data });
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.skill.delete({ where: { id } });
  }

  async findManyPaginated(
    filter: { search?: string },
    pagination: { skip: number; take: number },
  ): Promise<{ items: Skill[]; total: number }> {
    const where: Prisma.SkillWhereInput = filter.search
      ? { name: { contains: filter.search, mode: 'insensitive' } }
      : {};
    const [items, total] = await Promise.all([
      this.prisma.skill.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.skill.count({ where }),
    ]);
    return { items, total };
  }
}
