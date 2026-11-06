import { randomBytes } from 'node:crypto';
import type { Socket } from 'socket.io';

interface Participant {
  id: string;
  data: { userId?: string };
  emit(event: string, payload?: unknown): unknown;
}

interface GreenRoom {
  host: Socket;
  token: string;
  guests: Map<string, Participant>;
  limit: number;
}

export class LiveGuests {
  private readonly rooms = new Map<string, GreenRoom>();
  private readonly memberships = new Map<string, GreenRoom>();

  open(host: Socket, limit: number) {
    const existing = this.memberships.get(host.id);
    if (existing) return existing.host === host ? { token: existing.token, limit: existing.limit } : null;
    const token = randomBytes(24).toString('base64url');
    const room = { host, token, guests: new Map<string, Participant>(), limit };
    this.rooms.set(token, room);
    this.memberships.set(host.id, room);
    return { token, limit };
  }

  hasInvite(token: string) { return this.rooms.has(token); }

  join(guest: Participant, token: string) {
    const room = this.rooms.get(token);
    if (!room || this.memberships.has(guest.id) || room.host.data.userId === guest.data.userId) return { ok: false, error: 'This guest invitation is unavailable.' };
    if (room.guests.size >= room.limit) return { ok: false, error: 'The guest seats are full.' };
    if ([...room.guests.values()].some((member) => member.data.userId === guest.data.userId)) return { ok: false, error: 'This account is already in the green room.' };
    room.guests.set(guest.id, guest);
    this.memberships.set(guest.id, room);
    room.host.emit('live:guest-arrived', { id: guest.id });
    return { ok: true, host: room.host.id };
  }

  signal(sender: Participant, target: string, payload: unknown) {
    const room = this.memberships.get(sender.id);
    if (!room) return false;
    const peer = room.host.id === sender.id ? room.guests.get(target) : room.host.id === target ? room.host : undefined;
    if (!peer) return false;
    peer.emit('live:guest-signal', { from: sender.id, payload });
    return true;
  }

  remove(host: Socket, target: string) {
    const room = this.memberships.get(host.id);
    const guest = room?.host === host ? room.guests.get(target) : undefined;
    if (guest) { this.leave(guest); guest.emit('live:guest-closed'); }
    return !!guest;
  }

  leave(socket: Participant) {
    const room = this.memberships.get(socket.id);
    if (!room) return;
    this.memberships.delete(socket.id);
    if (room.host.id !== socket.id) {
      room.guests.delete(socket.id);
      room.host.emit('live:guest-left', { id: socket.id });
      return;
    }
    this.rooms.delete(room.token);
    for (const guest of room.guests.values()) {
      this.memberships.delete(guest.id);
      guest.emit('live:guest-closed');
    }
  }
}
