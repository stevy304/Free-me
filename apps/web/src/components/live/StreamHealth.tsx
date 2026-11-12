'use client';

export interface StreamHealthData {
  state: 'offline' | 'waiting' | 'healthy' | 'warning' | 'lost'; ready: boolean; warnings: string[];
  sample: { sampledAt: string; lastSegmentAt: string; width: number | null; height: number | null; fps: number | null; videoCodec: string | null; audioCodec: string | null; hasAudio: boolean | null; deliveredKbps: number; segments: number } | null;
}
const labels = { offline: 'No encoder connected', waiting: 'Waiting for video', healthy: 'Video arriving', warning: 'Slow video delivery', lost: 'Signal interrupted' };
export function StreamHealth({ health }: { health: StreamHealthData }) {
  const s = health.sample;
  const tone = health.state === 'healthy' ? 'border-emerald-500/30 bg-emerald-400/10 text-emerald-200' : health.state === 'lost' ? 'border-red-400/30 bg-red-400/10 text-red-200' : 'border-amber-400/30 bg-amber-400/10 text-amber-100';
  return <section aria-labelledby="stream-health-title" className="rounded-2xl border border-[#29444d] bg-[#0a2027] p-4 text-[#edf6f7]">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="stream-health-title" className="text-base font-bold">Stream health</h2><span role="status" className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${tone}`}>{labels[health.state]}</span></div>
    <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
      {[
        ['Resolution', s?.width && s?.height ? `${s.width} × ${s.height}` : 'Not measured'],
        ['Frame rate', s?.fps ? `${Math.round(s.fps * 10) / 10} fps` : 'Not measured'],
        ['Delivered bitrate', s ? `${s.deliveredKbps.toLocaleString()} kbps` : 'Not measured'],
        ['Audio track', s?.hasAudio === true ? s.audioCodec?.toUpperCase() ?? 'Detected' : s?.hasAudio === false ? 'Not detected' : 'Not measured'],
      ].map(([label, value]) => <div key={label} className="min-w-0 rounded-xl border border-[#29444d] bg-[#061a20] px-3 py-3"><dt className="text-[#97bac4]">{label}</dt><dd className="mt-1 break-words text-sm font-bold">{value}</dd></div>)}
    </dl>
    {health.warnings.length > 0 && <ul className="mt-3 space-y-1 text-xs leading-relaxed text-amber-100">{health.warnings.map((warning) => <li key={warning}>• {warning}</li>)}</ul>}
    <p className="mt-3 text-[11px] leading-relaxed text-[#97bac4]">Measured from arriving video segments about every five seconds. Bitrate includes transport overhead. Encoder dropped frames and microphone loudness are not reported here.</p>
    {s && <p className="mt-1 text-[11px] text-[#97bac4]">Last segment: <time dateTime={s.lastSegmentAt}>{new Date(s.lastSegmentAt).toLocaleTimeString()}</time></p>}
  </section>;
}
