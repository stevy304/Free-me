/**
 * Instant updates. Anything (an API request, the worker) calls `publish(room, event)`; every browser that joined
 * the room hears it at once, whichever API server it is connected to (Redis carries it between servers).
 * Rooms: `user:<id>` (joined automatically when signed in), `video:<id>` and `live:<id>` (joined by watch pages).
 * Events carry little: mostly "this changed", and the page fetches what it shows through the normal API, where
 * every permission check already lives.
 */
type Sink = (room: string, event: string, data: unknown) => void;
let sink: Sink | null = null;

export function setRealtimeSink(s: Sink | null) { sink = s; }

export function publish(room: string, event: string, data: object = {}) {
  try { sink?.(room, event, data); } catch { /* an update that cannot be sent is not an error for the caller */ }
}

export const room = {
  user: (id: string) => `user:${id}`,
  video: (id: string) => `video:${id}`,
  live: (id: string) => `live:${id}`,
};

/** Rooms a browser may ask to join (anyone may: they carry only public changes). */
export const JOINABLE = /^(video|live):[0-9a-f-]{36}$/;
