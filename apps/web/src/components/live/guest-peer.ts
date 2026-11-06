import type { Socket } from 'socket.io-client';

export type GuestSignal = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };

export function guestPeer(socket: Socket, target: string, iceServers: RTCIceServer[], onMedia: (stream: MediaStream) => void, returnAudio?: () => MediaStreamTrack | undefined) {
  const pc = new RTCPeerConnection({ iceServers });
  const stream = new MediaStream();
  const pending: RTCIceCandidateInit[] = [];
  const send = (payload: GuestSignal) => socket.emit('live:guest-signal', { target, payload });
  pc.onicecandidate = ({ candidate }) => { if (candidate) send({ candidate: candidate.toJSON() }); };
  pc.ontrack = ({ track }) => { stream.addTrack(track); onMedia(new MediaStream(stream.getTracks())); };
  return {
    pc,
    async offer() {
      await pc.setLocalDescription(await pc.createOffer());
      send({ description: pc.localDescription!.toJSON() });
    },
    async receive(payload: GuestSignal) {
      if (payload.description) {
        await pc.setRemoteDescription(payload.description);
        for (const candidate of pending.splice(0)) await pc.addIceCandidate(candidate);
        if (payload.description.type === 'offer') {
          const track = returnAudio?.();
          if (track) pc.addTrack(track);
          await pc.setLocalDescription(await pc.createAnswer());
          send({ description: pc.localDescription!.toJSON() });
        }
      }
      if (payload.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(payload.candidate);
        else pending.push(payload.candidate);
      }
    },
  };
}
