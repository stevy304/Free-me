type Details = { title: string; description: string; category: string; visibility: string };
type State = { id?: string; offset?: number; statusUrl?: string; error?: string };

async function call(path: string, signal: AbortSignal, options?: RequestInit) {
  const response = await fetch('/api/uploads' + path, { ...options, signal, cache: 'no-store' });
  const state: State = await response.json().catch(() => ({}));
  return { response, state };
}

async function fileKey(file: File) {
  const sample = new Blob([file.slice(0, 65536), file.slice(Math.max(0, file.size - 65536))]);
  const hash = await crypto.subtle.digest('SHA-256', await sample.arrayBuffer());
  const fingerprint = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return 'freeme-upload:' + JSON.stringify([file.name, file.size, file.lastModified, fingerprint]);
}

function save(key: string, id?: string) {
  try {
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  } catch { /* Upload remains usable in browsers that block local storage. */ }
}

function load(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function requestError(response: Response, state: State) {
  return new Error(state.error || `Upload request failed (HTTP ${response.status}).`);
}

export async function sendResumableVideo(
  file: File, details: Details, chunkBytes: number, signal: AbortSignal, onProgress: (percent: number) => void,
) {
  const key = await fileKey(file);
  let id = load(key);
  let offset = 0;
  if (id) {
    const { response, state } = await call('/' + id, signal);
    if (response.status === 404 || response.status === 410) {
      save(key);
      id = null;
    } else {
      if (!response.ok) throw requestError(response, state);
      if (state.statusUrl) { save(key); return state.statusUrl; }
      offset = state.offset ?? 0;
    }
  }
  if (!id) {
    const { response, state } = await call('', signal, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...details, size: file.size }),
    });
    if (!response.ok) throw requestError(response, state);
    if (!state.id) throw new Error('The upload API did not create a session. Update and restart Free Me.');
    id = state.id;
    save(key, id);
  }
  onProgress(Math.floor(offset / file.size * 100));
  while (offset < file.size) {
    const chunk = file.slice(offset, offset + chunkBytes);
    const { response, state } = await call('/' + id, signal, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Upload-Offset': String(offset),
        'X-Upload-Length': String(chunk.size),
      },
      body: chunk,
    });
    if (response.status === 413 && chunkBytes > 65536) {
      chunkBytes = Math.max(65536, Math.floor(chunkBytes / 2));
      continue;
    }
    if (!response.ok) throw requestError(response, state);
    if (state.offset !== offset + chunk.size) throw new Error('The server did not confirm the uploaded chunk.');
    offset = state.offset;
    onProgress(Math.floor(offset / file.size * 100));
  }
  const { response, state } = await call('/' + id + '/complete', signal, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(details),
  });
  if (!response.ok) throw requestError(response, state);
  if (!state.statusUrl || !/^\/videos\/[a-f0-9-]{36}$/.test(state.statusUrl)) throw new Error('The server did not confirm processing.');
  save(key);
  return state.statusUrl;
}
