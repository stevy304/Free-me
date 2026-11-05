'use client';

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { VideoUpload, type UploadSnapshot } from '@/lib/uploader';

interface Uploads {
  /** Uploads of this browser tab; they keep going while you move around the site. */
  items: Array<{ id: number; upload: VideoUpload; snap: UploadSnapshot }>;
  start: (file: File) => number;
  dialog: { open: boolean; uploadId: number | null };
  openDialog: (uploadId?: number | null) => void;
  closeDialog: () => void;
}
const Ctx = createContext<Uploads | null>(null);

export function UploadsProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Uploads['items']>([]);
  const [dialog, setDialog] = useState<Uploads['dialog']>({ open: false, uploadId: null });
  const next = useRef(1);
  const start = useCallback((file: File) => {
    const id = next.current++;
    const upload = new VideoUpload(file, (snap) => setItems((list) => list.map((i) => (i.id === id ? { ...i, snap } : i))));
    setItems((list) => [...list, { id, upload, snap: upload.snapshot }]);
    void upload.start();
    return id;
  }, []);
  const openDialog = useCallback((uploadId: number | null = null) => setDialog({ open: true, uploadId }), []);
  const closeDialog = useCallback(() => setDialog({ open: false, uploadId: null }), []);
  return <Ctx.Provider value={{ items, start, dialog, openDialog, closeDialog }}>{children}</Ctx.Provider>;
}

export function useUploads() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useUploads outside UploadsProvider');
  return v;
}
