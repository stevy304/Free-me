// RTMP ingest on :1935 (OBS, Streamlabs, vMix, Larix…). Node-Media-Server only receives and relays; every decision
// is made by the API:
//   prePublish  -> POST /api/rtmp/on_publish   (stream key valid? otherwise the publisher is dropped)
//   donePublish -> POST /api/rtmp/on_done      (the API keeps a 30 s window for OBS to reconnect)
//   prePlay     -> only this machine may pull streams (the API's FFmpeg mixer, HLS, recorder, restreams)
// A small stats endpoint on 127.0.0.1:RTMP_STATS_PORT gives the API each publisher's bitrate, FPS and size.

const http = require('http');
const NodeMediaServer = require('node-media-server');
const context = require('node-media-server/src/node_core_ctx');

const API = (process.env.API_INTERNAL_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const SECRET = process.env.RTMP_HOOK_SECRET || '';
const PORT = Number(process.env.RTMP_PORT || 1935);
const STATS_PORT = Number(process.env.RTMP_STATS_PORT || 8001);

const nms = new NodeMediaServer({
  logType: Number(process.env.RTMP_LOG_LEVEL || 1),
  rtmp: { port: PORT, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 },
});

const isLocal = (ip) => !ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
const ipOf = (session) => session && session.socket ? session.socket.remoteAddress : undefined;

async function hook(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rtmp-secret': SECRET },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

nms.on('prePublish', (id, streamPath, args) => {
  const session = nms.getSession(id);
  const ip = ipOf(session);
  // Publishing has already started inside NMS; nothing reads the stream until the API allows it, and a refusal
  // drops the connection at once.
  hook('/api/rtmp/on_publish', { session_id: id, stream_path: streamPath, ip, local: isLocal(ip), args })
    .then((r) => {
      if (!r.allow) {
        console.log(`[rtmp] refused ${streamPath} from ${ip}: ${r.reason || 'invalid stream key'}`);
        session && session.reject();
      }
    })
    .catch((e) => {
      console.error(`[rtmp] could not check ${streamPath}: ${e.message}; refusing`);
      session && session.reject();
    });
});

nms.on('donePublish', (id, streamPath) => {
  hook('/api/rtmp/on_done', { session_id: id, stream_path: streamPath }).catch((e) => console.error(`[rtmp] on_done: ${e.message}`));
});

nms.on('prePlay', (id, streamPath) => {
  const session = nms.getSession(id);
  if (!isLocal(ipOf(session))) {
    console.log(`[rtmp] refused play of ${streamPath} from ${ipOf(session)}`);
    session && session.reject();
  }
});

nms.run();

// Publisher stats for stream health.
const sessions = () => {
  const out = {};
  for (const [, s] of context.sessions) {
    if (!s.isPublishing || !s.publishStreamPath) continue;
    out[s.publishStreamPath] = {
      session_id: s.id,
      ip: ipOf(s),
      bitrate_kbps: s.bitrate || 0,
      fps: s.videoFps || 0,
      width: s.videoWidth || 0,
      height: s.videoHeight || 0,
      video_codec: s.videoCodecName || null,
      audio_codec: s.audioCodecName || null,
      has_audio: !!s.audioCodec,
      has_video: !!s.videoCodec,
      started_at: s.startTimestamp || null,
    };
  }
  return out;
};

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/kick') {
    // The API ended the stream: disconnect that publisher.
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const { stream_path: path } = JSON.parse(body || '{}');
        const id = context.publishers.get(path);
        const session = id && context.sessions.get(id);
        if (session) session.reject();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ kicked: !!session }));
      } catch (e) { res.writeHead(400); res.end(); }
    });
    return;
  }
  if (req.url === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(sessions()));
  }
  res.writeHead(404); res.end();
}).listen(STATS_PORT, '127.0.0.1', () => console.log(`[rtmp] ingest :${PORT}, stats 127.0.0.1:${STATS_PORT}, hooks ${API}`));
