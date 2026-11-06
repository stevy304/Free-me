'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import { getSocket } from '@/lib/realtime';
import { guestPeer, type GuestSignal } from '@/components/live/guest-peer';

export function JoinBroadcast({ invite }: { invite: string }) {
  const preview = useRef<HTMLVideoElement>(null);
  const returnAudio = useRef<HTMLAudioElement>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const [state, setState] = useState<'idle' | 'joining' | 'joined'>('idle');
  const [message, setMessage] = useState('');
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cleanup.current?.(); };
  }, []);

  const join = async () => {
    setState('joining'); setMessage('');
    try {
      const media = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 } }, audio: { echoCancellation: true } });
      if (!mounted.current) { media.getTracks().forEach((t) => t.stop()); return; }
      cleanup.current = () => media.getTracks().forEach((t) => t.stop());
      if (preview.current) preview.current.srcObject = media;
      const [{ iceServers }, socket] = await Promise.all([api<{ iceServers: RTCIceServer[] }>('/live/ice'), getSocket()]);
      if (!mounted.current) return;
      const result = await socket.timeout(8000).emitWithAck('live:guest-join', invite);
      if (!mounted.current) { socket.emit('live:guest-leave'); return; }
      if (!result.ok) throw new Error(result.error ?? 'The invitation is unavailable.');
      const mediaCleanup = cleanup.current;
      cleanup.current = () => { socket.emit('live:guest-leave'); mediaCleanup?.(); };
      const peer = guestPeer(socket, result.host, iceServers, (stream) => {
        if (returnAudio.current) {
          returnAudio.current.srcObject = stream;
          void returnAudio.current.play().catch(() => setMessage('Press Play on the audio player to hear the host.'));
        }
      });
      let chain = Promise.resolve();
      const signal = ({ from, payload }: { from: string; payload: GuestSignal }) => {
        if (from === result.host) chain = chain.then(() => peer.receive(payload)).catch(() => setMessage('Could not connect to the host.'));
      };
      const closed = () => { cleanup.current?.(); setState('idle'); setMessage('The green room closed or disconnected.'); };
      socket.on('live:guest-signal', signal);
      socket.on('live:guest-closed', closed); socket.on('disconnect', closed);
      cleanup.current = () => {
        socket.off('live:guest-signal', signal); socket.off('live:guest-closed', closed); socket.off('disconnect', closed);
        socket.emit('live:guest-leave'); peer.pc.close(); media.getTracks().forEach((t) => t.stop());
        if (preview.current) preview.current.srcObject = null;
        if (returnAudio.current) returnAudio.current.srcObject = null;
        cleanup.current = null;
      };
      for (const track of media.getTracks()) peer.pc.addTrack(track, media);
      peer.pc.onconnectionstatechange = () => {
        if (peer.pc.connectionState === 'connected') setMessage('Connected. The host decides when to put you on air.');
        if (peer.pc.connectionState === 'failed') { cleanup.current?.(); setState('idle'); setMessage('The media connection failed. Try joining again.'); }
      };
      await peer.offer();
      if (mounted.current) { setState('joined'); setMessage('Connecting your camera and microphone to the host…'); }
    } catch (error) {
      cleanup.current?.();
      if (mounted.current) { setState('idle'); setMessage((error as Error).message); }
    }
  };

  return <main className="mx-auto max-w-3xl space-y-4 px-4 py-8">
    <h1 className="font-display text-3xl font-bold">Join a broadcast</h1>
    <p className="text-muted">Preview your camera here. Your camera and microphone are shared with the host after you join.</p>
    <video ref={preview} autoPlay muted playsInline className="aspect-video w-full rounded-2xl bg-black" />
    <audio ref={returnAudio} autoPlay controls className={state === 'joined' ? 'w-full' : 'hidden'} />
    {message && <p role="status" className="text-sm text-muted">{message}</p>}
    {state === 'joined' ? <button type="button" className="rounded-xl bg-danger px-4 py-2 font-semibold text-white" onClick={() => { cleanup.current?.(); setState('idle'); setMessage('You left the green room.'); }}>Leave</button> :
      <button type="button" disabled={state === 'joining'} className="rounded-xl bg-brand px-4 py-2 font-semibold text-on-brand disabled:opacity-50" onClick={() => void join()}>{state === 'joining' ? 'Joining…' : 'Join with camera and microphone'}</button>}
  </main>;
}
