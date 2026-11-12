'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export function useLiveDevices(onError: (message: string | null) => void) {
  const [media, setMedia] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [microphoneId, setMicrophoneId] = useState('');
  const [busy, setBusy] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [microphoneOn, setMicrophoneOn] = useState(false);
  const [info, setInfo] = useState<MediaTrackSettings | null>(null);
  const request = useRef(0);
  const current = useRef<MediaStream | null>(null);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const list = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    if (mounted.current) setDevices(list);
  }, []);
  useEffect(() => {
    mounted.current = true; void refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => { mounted.current = false; request.current++; current.current?.getTracks().forEach((t) => t.stop()); navigator.mediaDevices?.removeEventListener('devicechange', refresh); };
  }, [refresh]);

  const connect = async (camera = true, videoId = cameraId, audioId = microphoneId, withAudio = true) => {
    const id = ++request.current;
    setBusy(true); onError(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Open Free Me over HTTPS or localhost to connect your camera and microphone.');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: camera ? { ...(videoId ? { deviceId: { exact: videoId } } : {}), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } : false,
        audio: withAudio ? { ...(audioId ? { deviceId: { exact: audioId } } : {}), echoCancellation: true, noiseSuppression: true } : false,
      });
      if (!mounted.current || id !== request.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      const previous = current.current;
      current.current = stream; setMedia(stream);
      const video = stream.getVideoTracks()[0], audio = stream.getAudioTracks()[0];
      if (video) video.enabled = previous?.getVideoTracks()[0]?.enabled ?? true;
      if (audio) audio.enabled = previous?.getAudioTracks()[0]?.enabled ?? true;
      setCameraOn(!!video?.enabled); setMicrophoneOn(!!audio?.enabled); setInfo(video?.getSettings() ?? null);
      setCameraId(video?.getSettings().deviceId ?? videoId); setMicrophoneId(audio?.getSettings().deviceId ?? audioId);
      for (const track of stream.getTracks()) track.addEventListener('ended', () => {
        if (current.current !== stream || !mounted.current) return;
        if (track.kind === 'video') { setCameraOn(false); setInfo(null); } else setMicrophoneOn(false);
        if (stream.getTracks().every((t) => t.readyState === 'ended')) { current.current = null; setMedia(null); }
        onError(`${track.kind === 'video' ? 'Camera' : 'Microphone'} disconnected. Open Devices to reconnect or choose another input.`);
      });
      previous?.getTracks().forEach((t) => t.stop());
      await refresh();
    } catch (error) {
      if (!mounted.current || id !== request.current) return;
      const name = error instanceof DOMException ? error.name : '';
      onError(name === 'NotAllowedError' ? 'Camera or microphone permission was denied. Allow access in your browser’s site settings, then reconnect.'
        : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'That camera or microphone is unavailable. Choose another device, or try camera-only or microphone-only mode.'
        : name === 'NotReadableError' ? 'The device is busy. Close other apps using it, then try again.' : (error as Error).message);
    } finally { if (mounted.current && id === request.current) setBusy(false); }
  };
  const toggleCamera = () => {
    const tracks = current.current?.getVideoTracks().filter((t) => t.readyState === 'live') ?? [];
    if (!tracks.length) { void connect(true, cameraId, microphoneId, !current.current || !!current.current.getAudioTracks().length); return; }
    const enabled = !cameraOn; tracks.forEach((t) => { t.enabled = enabled; }); setCameraOn(enabled);
  };
  const toggleMicrophone = () => {
    const tracks = current.current?.getAudioTracks().filter((t) => t.readyState === 'live') ?? [];
    if (!tracks.length) { void connect(!!current.current?.getVideoTracks().length, cameraId, microphoneId, true); return; }
    const enabled = !microphoneOn; tracks.forEach((t) => { t.enabled = enabled; }); setMicrophoneOn(enabled);
  };
  const disconnect = () => { request.current++; current.current?.getTracks().forEach((t) => t.stop()); current.current = null; setMedia(null); setCameraOn(false); setMicrophoneOn(false); setInfo(null); setBusy(false); };
  return { media, devices, cameraId, microphoneId, cameraOn, microphoneOn, info, busy, connect, toggleCamera, toggleMicrophone, disconnect, refresh };
}
