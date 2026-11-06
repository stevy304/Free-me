'use client';

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { VideoUpload, type UploadSnapshot } from '@/lib/uploader';

/** What the creator is posting: a video, a Moment (vertical, up to 3 minutes) or a podcast (sound + cover). */
export type UploadKind = 'video' | 'moment' | 'podcast';

interface Uploads {
  /** Uploads of this browser tab; they keep going while you move around the site. */
  items: Array<{ id: number; upload: VideoUpload; snap: UploadSnapshot }>;
  start: (file: File) => number;
  dialog: { open: boolean; uploadId: number | null; kind: UploadKind };
  openDialog: (uploadId?: number | null, kind?: UploadKind) => void;
  closeDialog: () => void;
}
const Ctx = createContext<Uploads | null>(null);

export function UploadsProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Uploads['items']>([]);
  const [dialog, setDialog] = useState<Uploads['dialog']>({ open: false, uploadId: null, kind: 'video' });
  const next = useRef(1);
  const start = useCallback((file: File) => {
    const id = next.current++;
    const upload = new VideoUpload(file, (snap) => setItems((list) => list.map((i) => (i.id === id ? { ...i, snap } : i))));
    setItems((list) => [...list, { id, upload, snap: upload.snapshot }]);
    void upload.start();
    return id;
  }, []);
  const openDialog = useCallback((uploadId: number | null = null, kind: UploadKind = 'video') => setDialog({ open: true, uploadId, kind }), []);
  const closeDialog = useCallback(() => setDialog((d) => ({ open: false, uploadId: null, kind: d.kind })), []);
  return <Ctx.Provider value={{ items, start, dialog, openDialog, closeDialog }}>{children}</Ctx.Provider>;
}

export function useUploads() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useUploads outside UploadsProvider');
  return v;
}
