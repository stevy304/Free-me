import type { ReactNode } from 'react';

/**
 * Skeleton screens: the page's layout in soft grey, shown the moment a link is followed while the server fetches the
 * data, so navigation feels instant on slow connections. Shapes match the real components (16:10 cards, 22px avatar
 * rows, the watch stage), so nothing jumps when the content arrives. The shimmer stops for reduced motion.
 */

export function Bone({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`rounded-xl bg-surface motion-safe:animate-pulse ${className}`} />;
}

/** One grid card: the 16:10 frame, then the creator line. */
export function CardBone() {
  return (
    <div>
      <Bone className="aspect-[16/10] rounded-2xl" />
      <div className="mt-2.5 flex items-center gap-2"><Bone className="h-[22px] w-[22px] rounded-full" /><Bone className="h-3.5 w-2/3" /></div>
    </div>
  );
}

/** A shelf: heading and a row of cards (four from 1024px, like the real shelves). */
export function ShelfBone({ cards = 4 }: { cards?: number }) {
  return (
    <section className="mt-9">
      <Bone className="h-6 w-48" />
      <div className="mt-3 grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: cards }, (_, i) => <div key={i} className={i >= 1 ? 'hidden sm:block' : ''}><CardBone /></div>)}
      </div>
    </section>
  );
}

/** Wraps a skeleton page: announced once to screen readers, then hidden from them. */
export function Loading({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={className}>
      <span className="sr-only">{label}</span>
      <div aria-hidden>{children}</div>
    </div>
  );
}

/** Home, Following and other feeds: title, spotlight with side panel, shelves. */
export function FeedSkeleton({ spotlight = true }: { spotlight?: boolean }) {
  return (
    <Loading label="Loading videos" className="mx-auto max-w-[1600px] px-4 pt-3 sm:px-6">
      <Bone className="h-9 w-40" />
      <Bone className="mt-2 h-4 w-64" />
      {spotlight && (
        <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_340px]">
          <Bone className="min-h-[300px] rounded-2xl sm:min-h-[380px]" />
          <Bone className="hidden rounded-2xl lg:block" />
        </div>
      )}
      <ShelfBone />
      <ShelfBone />
    </Loading>
  );
}

/** The watch page: stage, title, actions, then the up-next list. */
export function WatchSkeleton() {
  return (
    <Loading label="Loading video">
      <div className="bg-[#0b0908] sm:px-6 sm:py-6">
        <div className="mx-auto grid max-w-[1760px] gap-6 lg:grid-cols-[360px_1fr]">
          <div className="order-2 hidden space-y-4 rounded-2xl bg-white/5 p-5 lg:order-1 lg:block">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex gap-3"><div className="aspect-[16/10] w-[150px] shrink-0 rounded-xl bg-white/10 motion-safe:animate-pulse" /><div className="flex-1 space-y-2 pt-1"><div className="h-3.5 rounded bg-white/10" /><div className="h-3 w-2/3 rounded bg-white/10" /></div></div>
            ))}
          </div>
          <div className="order-1 lg:order-2">
            <div className="aspect-video w-full bg-white/[0.06] motion-safe:animate-pulse sm:rounded-2xl" />
            <div className="space-y-3 px-4 py-4 sm:px-0">
              <div className="h-7 w-3/4 rounded-lg bg-white/10" />
              <div className="flex gap-3"><div className="h-4 w-40 rounded bg-white/10" /></div>
              <div className="flex gap-2 pt-1">{[96, 120, 96].map((w, i) => <div key={i} className="h-10 rounded-full bg-white/10" style={{ width: w }} />)}</div>
            </div>
          </div>
        </div>
      </div>
    </Loading>
  );
}

/** A Space: banner, avatar and name, tabs, a grid. */
export function ChannelSkeleton() {
  return (
    <Loading label="Loading Space" className="mx-auto max-w-[1284px] px-4 pb-10 sm:px-6">
      <Bone className="mt-2 aspect-[6/1] w-full rounded-2xl" />
      <div className="mt-5 flex items-center gap-5">
        <Bone className="h-20 w-20 shrink-0 rounded-2xl sm:h-40 sm:w-40" />
        <div className="flex-1 space-y-3"><Bone className="h-8 w-56" /><Bone className="h-4 w-72 max-w-full" /><Bone className="h-10 w-28" /></div>
      </div>
      <div className="mt-6 flex gap-6 border-b border-line pb-3"><Bone className="h-5 w-16" /><Bone className="h-5 w-16" /></div>
      <div className="mt-5 grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <CardBone key={i} />)}</div>
    </Loading>
  );
}

/** Search results: heading, then rows (thumbnail beside text). */
export function ResultsSkeleton() {
  return (
    <Loading label="Searching" className="mx-auto max-w-[1100px] px-4 pb-16 pt-5 sm:px-6">
      <Bone className="h-8 w-72 max-w-full" />
      <Bone className="mt-2 h-4 w-32" />
      <div className="mt-8 space-y-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex gap-4"><Bone className="aspect-[16/10] w-[42%] max-w-[340px] shrink-0 rounded-2xl" /><div className="flex-1 space-y-2.5 pt-1"><Bone className="h-5 w-4/5" /><Bone className="h-4 w-40" /><Bone className="h-3.5 w-32" /></div></div>
        ))}
      </div>
    </Loading>
  );
}

/** Creator Hub and other tables. */
export function TableSkeleton({ label = 'Loading' }: { label?: string }) {
  return (
    <Loading label={label} className="mx-auto max-w-[1400px] px-4 pb-10 pt-6 sm:px-6">
      <Bone className="h-9 w-56" />
      <div className="mt-6 flex gap-6 border-b border-line pb-3">{[70, 60, 100, 140].map((w) => <div key={w} style={{ width: w }}><Bone className="h-5" /></div>)}</div>
      <div className="mt-5 space-y-px overflow-hidden rounded-3xl border border-line">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center gap-4 bg-elevated p-4"><Bone className="aspect-[16/9] w-[128px] shrink-0 rounded-lg" /><div className="flex-1 space-y-2"><Bone className="h-4 w-1/2" /><Bone className="h-3.5 w-1/3" /></div><Bone className="hidden h-4 w-20 sm:block" /></div>
        ))}
      </div>
    </Loading>
  );
}
