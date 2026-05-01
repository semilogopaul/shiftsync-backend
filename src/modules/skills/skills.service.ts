import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Role, Skill } from '@prisma/client';

import { SkillsRepository } from './skills.repository';
import { AuditLogService } from '../audit-log/audit-log.service';

interface RequestContext {
  readonly actorId: string;
  readonly actorRole: Role;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

@Injectable()
export class SkillsService {
  constructor(
    private readonly repo: SkillsRepository,
    private readonly audit: AuditLogService,
  ) {}

  async list(filter: { search?: string }, pagination: { skip: number; take: number }) {
    return this.repo.findManyPaginated(filter, pagination);
  }

  async getById(id: string): Promise<Skill> {
    const found = await this.repo.findById(id);
    if (!found) throw new NotFoundException('Skill not found');
    return found;
  }

  async create(name: string, ctx: RequestContext): Promise<Skill> {
    const trimmed = name.trim().toLowerCase();
    const existing = await this.repo.findByName(trimmed);
    if (existing) throw new ConflictException('A skill with that name already exists');
    const created = await this.repo.createOne({ name: trimmed });
    this.audit.log({
      action: AuditAction.SKILL_CREATED,
      entityType: 'Skill',
      entityId: created.id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      after: created,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return created;
  }

  async update(id: string, name: string, ctx: RequestContext): Promise<Skill> {
    const before = await this.repo.findById(id);
    if (!before) throw new NotFoundException('Skill not found');
    const trimmed = name.trim().toLowerCase();
    if (trimmed === before.name) return before;
    const collision = await this.repo.findByName(trimmed);
    if (collision && collision.id !== id) {
      throw new ConflictException('Another skill already uses that name');
    }
    const after = await this.repo.updateById(id, { name: trimmed });
    this.audit.log({
      action: AuditAction.SKILL_UPDATED,
      entityType: 'Skill',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      before,
      after,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return after;
  }

  async remove(id: string, ctx: RequestContext): Promise<void> {
    const before = await this.repo.findById(id);
    if (!before) throw new NotFoundException('Skill not found');
    await this.repo.deleteById(id);
    this.audit.log({
      action: AuditAction.SKILL_DELETED,
      entityType: 'Skill',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      before,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }
}
