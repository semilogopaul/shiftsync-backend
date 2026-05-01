import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

import { ACCESS_TOKEN_COOKIE } from '../../common/constants/cookie.constants';
import { JwtPayload } from '../auth/strategies/jwt.strategy';

/**
 * Realtime gateway. Clients connect over Socket.IO with the access-token
 * cookie set (or token query param as a fallback for tooling). Each user is
 * placed into a room named `user:<id>` so we can target individual
 * notifications, and into `loc:<id>` rooms when they subscribe to a location
 * for live on-duty / schedule updates.
 */
@WebSocketGateway({
  namespace: '/realtime',
  cors: { origin: true, credentials: true },
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  // ─── Connection lifecycle ────────────────────────────────────────────

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = this.extractToken(client);
      if (!token) {
        client.emit('error', { code: 'UNAUTHENTICATED' });
        client.disconnect(true);
        return;
      }
      const payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
      });
      client.data.userId = payload.sub;
      client.data.role = payload.role;
      await client.join(`user:${payload.sub}`);

      // Optional location subscriptions via handshake query: ?locations=loc1,loc2
      const locParam = client.handshake.query.locations;
      const locations = Array.isArray(locParam) ? locParam : typeof locParam === 'string' ? locParam.split(',') : [];
      for (const id of locations.filter(Boolean)) {
        await client.join(`loc:${id}`);
      }

      client.emit('ready', { userId: payload.sub });
    } catch (err) {
      this.logger.warn(`realtime auth failed: ${(err as Error).message}`);
      client.emit('error', { code: 'UNAUTHENTICATED' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    if (client.data.userId) {
      this.logger.debug(`disconnect user=${client.data.userId} sock=${client.id}`);
    }
  }

  private extractToken(client: Socket): string | null {
    // 1) Auth handshake (preferred for native SDKs)
    const authToken = (client.handshake.auth as { token?: string } | undefined)?.token;
    if (authToken) return authToken;
    // 2) Cookie
    const cookieHeader = client.handshake.headers.cookie ?? '';
    const match = cookieHeader.split(/;\s*/).find((c) => c.startsWith(`${ACCESS_TOKEN_COOKIE}=`));
    if (match) return decodeURIComponent(match.split('=').slice(1).join('='));
    // 3) Query string fallback
    const q = client.handshake.query.token;
    if (typeof q === 'string') return q;
    return null;
  }

  // ─── Targeted broadcasts ─────────────────────────────────────────────

  emitToUser(userId: string, event: string, data: unknown): void {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  emitToLocation(locationId: string, event: string, data: unknown): void {
    this.server.to(`loc:${locationId}`).emit(event, data);
  }

  // ─── Event listeners (bridge from EventEmitter2) ─────────────────────

  @OnEvent('notification.created')
  onNotificationCreated(payload: { userId: string; notification: unknown }): void {
    this.emitToUser(payload.userId, 'notification', payload.notification);
  }

  @OnEvent('shift.assigned')
  onShiftAssigned(payload: { shiftId: string; userId: string; locationId: string; published: boolean }): void {
    this.emitToUser(payload.userId, 'shift.assigned', payload);
    this.emitToLocation(payload.locationId, 'shift.assigned', payload);
  }

  @OnEvent('shift.unassigned')
  onShiftUnassigned(payload: { shiftId: string; userId: string; locationId: string }): void {
    this.emitToUser(payload.userId, 'shift.unassigned', payload);
    this.emitToLocation(payload.locationId, 'shift.unassigned', payload);
  }

  @OnEvent('shift.published')
  onShiftPublished(payload: { shiftId: string; locationId: string }): void {
    this.emitToLocation(payload.locationId, 'shift.published', payload);
  }

  @OnEvent('shift.updated')
  onShiftUpdated(payload: { shiftId: string; locationId: string }): void {
    this.emitToLocation(payload.locationId, 'shift.updated', payload);
  }

  @OnEvent('shift.deleted')
  onShiftDeleted(payload: { shiftId: string; locationId: string }): void {
    this.emitToLocation(payload.locationId, 'shift.deleted', payload);
  }

  @OnEvent('swap.*')
  onSwapEvent(payload: unknown, eventName?: string): void {
    const p = payload as { fromUserId?: string; toUserId?: string; locationId?: string };
    if (p?.fromUserId) this.emitToUser(p.fromUserId, eventName ?? 'swap.event', payload);
    if (p?.toUserId) this.emitToUser(p.toUserId, eventName ?? 'swap.event', payload);
    if (p?.locationId) this.emitToLocation(p.locationId, eventName ?? 'swap.event', payload);
  }

  @OnEvent('drop.*')
  onDropEvent(payload: unknown, eventName?: string): void {
    const p = payload as { fromUserId?: string; claimedById?: string; locationId?: string };
    if (p?.fromUserId) this.emitToUser(p.fromUserId, eventName ?? 'drop.event', payload);
    if (p?.claimedById) this.emitToUser(p.claimedById, eventName ?? 'drop.event', payload);
    if (p?.locationId) this.emitToLocation(p.locationId, eventName ?? 'drop.event', payload);
  }

  @OnEvent('clock.*')
  onClockEvent(payload: unknown, eventName?: string): void {
    const p = payload as { userId?: string; locationId?: string };
    if (p?.locationId) this.emitToLocation(p.locationId, eventName ?? 'clock.event', payload);
    if (p?.userId) this.emitToUser(p.userId, eventName ?? 'clock.event', payload);
  }

  @OnEvent('shift.callout')
  onShiftCallout(payload: { shiftId: string; locationId: string }): void {
    this.emitToLocation(payload.locationId, 'shift.callout', payload);
  }

  @OnEvent('overtime.warning')
  onOvertimeWarning(payload: { userId: string; locationId: string }): void {
    if (payload?.userId) this.emitToUser(payload.userId, 'overtime.warning', payload);
    if (payload?.locationId) this.emitToLocation(payload.locationId, 'overtime.warning', payload);
  }

  @OnEvent('availability.changed')
  onAvailabilityChanged(payload: { userId: string }): void {
    if (payload?.userId) this.emitToUser(payload.userId, 'availability.changed', payload);
  }

  /**
   * Concurrent assignment conflict — when two managers try to assign the same
   * staff member at the same time, one request loses the race and emits this
   * event. We broadcast it both to the location (so other open editors see
   * a refresh) and to the affected staff member (so they can react).
   */
  @OnEvent('assignment.conflict')
  onAssignmentConflict(payload: {
    shiftId: string;
    userId: string;
    locationId: string;
    reason: string;
  }): void {
    if (payload?.locationId) this.emitToLocation(payload.locationId, 'assignment.conflict', payload);
    if (payload?.userId) this.emitToUser(payload.userId, 'assignment.conflict', payload);
  }
}
