import { useId, type ReactNode, type SVGProps } from 'react';

/**
 * Free Me icon set: drawn for this app on a 24 px grid with a 1.75 px rounded stroke, soft corners and
 * open terminals. Icons that mark a place in the app (Home, Moments, Following, ...) have a filled
 * variant for the current page: pass `filled`.
 */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'fill'> {
  size?: number;
  strokeWidth?: number;
  filled?: boolean;
}

/**
 * `draw` paints the icon. `cut` is the detail on top (a play mark, a tick...): drawn in the stroke colour on outline
 * icons, and cut out of the shape on filled ones, so the background shows through whatever it is.
 */
function icon(name: string, draw: (filled: boolean) => ReactNode, cut?: () => ReactNode, alwaysFilled = false) {
  const Icon = ({ size = 24, strokeWidth = 1.75, filled: wantFilled = false, className, ...rest }: IconProps) => {
    const id = useId();
    const filled = wantFilled || alwaysFilled;
    const masked = filled && cut;
    return (
      <svg
        width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
        strokeLinecap="round" strokeLinejoin="round" className={className}
        aria-hidden={rest['aria-label'] ? undefined : true} role={rest['aria-label'] ? 'img' : undefined} focusable="false" {...rest}
      >
        {masked ? (
          <>
            <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
              <rect width="24" height="24" fill="#fff" stroke="none" />
              <g stroke="#000" fill="#000" style={{ color: '#000' }}>{cut()}</g>
            </mask>
            <g mask={`url(#${id})`}>{draw(true)}</g>
          </>
        ) : (
          <>{draw(filled)}{cut?.()}</>
        )}
      </svg>
    );
  };
  Icon.displayName = `${name}Icon`;
  return Icon;
}

const F = (on: boolean) => (on ? 'currentColor' : 'none');
const TRI = (d: string) => <path d={d} fill="currentColor" strokeWidth={1.2} />;

/* ---------- Places ---------- */

export const Home = icon('Home', (f) => (
  <>
    <path d="M4 10.4 11.1 4.3a1.4 1.4 0 0 1 1.8 0L20 10.4V19a1.5 1.5 0 0 1-1.5 1.5H15v-5.3a3 3 0 0 0-6 0v5.3H5.5A1.5 1.5 0 0 1 4 19z" fill={F(f)} />
  </>
));

/** Moments: short vertical videos. A tall card with a spark. */
export const Moments = icon('Moments', (f) => (
  <>
    <rect x="4.5" y="3.5" width="12.5" height="17" rx="3.5" fill={F(f)} />
    <path d="M20.2 3v3.4M18.5 4.7h3.4" strokeWidth={1.6} />
  </>
), () => TRI('M9.2 9.3v5.4l4.4-2.7z'));

/** Following: the channels I follow, a card in front of a card. */
export const Following = icon('Following', (f) => (
  <>
    <path d="M6.5 4.5h11" />
    <rect x="3.5" y="7.5" width="17" height="12.5" rx="3" fill={F(f)} />
  </>
), () => TRI('M10.4 11v5.5l4.4-2.75z'));

/** Your channel: a person framed like a video. */
export const Channel = icon('Channel', (f) => <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" fill={F(f)} />,
  () => (<><circle cx="12" cy="10" r="2.6" /><path d="M7.6 17.2a5 5 0 0 1 8.8 0" /></>));

/** Creator Hub: a centre joined to the tools around it. */
export const Hub = icon('Hub', (f) => (
  <>
    <circle cx="12" cy="12" r="3.2" fill={F(f)} />
    <circle cx="12" cy="4" r="1.6" /><circle cx="19" cy="16" r="1.6" /><circle cx="5" cy="16" r="1.6" />
    <path d="M12 5.6v3.2M17.6 15.2l-2.9-1.6M6.4 15.2l2.9-1.6" />
  </>
));

/** My videos: a strip of frames. */
export const Videos = icon('Videos', (f) => <rect x="3" y="5" width="18" height="14" rx="3" fill={F(f)} />,
  () => <path d="M7 5v14M17 5v14M3 9.5h4M17 9.5h4M3 14.5h4M17 14.5h4" />);

export const History = icon('History', (f) => (
  <>
    <path d="M4.1 13.2A8 8 0 1 0 6.3 6.4" />
    {f && <circle cx="12" cy="12" r="7" fill="currentColor" stroke="none" />}
    <path d="M3.6 5.2v3.6h3.6" />
  </>
), () => <path d="M12 8.2V12l2.6 1.6" />);

/** Collections: a stack of cards with a ribbon. */
export const Collections = icon('Collections', (f) => (
  <>
    <path d="M7 3.5h10M5 6.5h14" />
    <rect x="3.5" y="9.5" width="17" height="11" rx="2.5" fill={F(f)} />
  </>
), () => <path d="M14 9.5v5.2l1.6-1.1 1.6 1.1V9.5" />);

export const Bookmark = icon('Bookmark', (f) => <path d="M7 3.8h10a1.2 1.2 0 0 1 1.2 1.2v15.4l-6.2-4.3-6.2 4.3V5A1.2 1.2 0 0 1 7 3.8z" fill={F(f)} />);

export const Compass = icon('Compass', (f) => <circle cx="12" cy="12" r="8.5" fill={F(f)} />, () => <path d="m15.4 8.6-2 4.8-4.8 2 2-4.8z" fill="currentColor" strokeWidth={1.2} />);

export const Settings = icon('Settings', (f) => (
  <>
    <path d="M10.3 3.4h3.4l.6 2.4 1.7 1 2.4-.7 1.7 3-1.8 1.7v2l1.8 1.7-1.7 3-2.4-.7-1.7 1-.6 2.4h-3.4l-.6-2.4-1.7-1-2.4.7-1.7-3 1.8-1.7v-2L3.7 9.1l1.7-3 2.4.7 1.7-1z" fill={F(f)} />
  </>
), () => <circle cx="12" cy="12" r="2.7" />);

export const Shield = icon('Shield', (f) => (
  <>
    <path d="M12 3.2 19 6v5.4c0 4.4-2.9 7.9-7 9.4-4.1-1.5-7-5-7-9.4V6z" fill={F(f)} />
  </>
), () => <path d="m9.2 12 2 2 3.8-3.9" />);

export const Bell = icon('Bell', (f) => (
  <>
    <path d="M6.2 16.5V11a5.8 5.8 0 0 1 11.6 0v5.5l1.5 1.7H4.7z" fill={F(f)} />
    <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
  </>
));

/* ---------- People ---------- */

export const Person = icon('Person', () => (
  <>
    <circle cx="12" cy="8.2" r="3.7" />
    <path d="M4.8 20.2a7.2 7.2 0 0 1 14.4 0" />
  </>
));
export const PersonCircle = icon('PersonCircle', () => (
  <>
    <circle cx="12" cy="12" r="8.6" />
    <circle cx="12" cy="10" r="2.9" />
    <path d="M6.8 18.3a6 6 0 0 1 10.4 0" />
  </>
));
export const PersonAdd = icon('PersonAdd', () => (
  <>
    <circle cx="10" cy="8.2" r="3.6" />
    <path d="M3.5 20a6.5 6.5 0 0 1 11.2-4.5" />
    <path d="M18.5 13.5v6M15.5 16.5h6" />
  </>
));

/* ---------- Actions ---------- */

export const Search = icon('Search', () => (<><circle cx="10.6" cy="10.6" r="6.4" /><path d="m15.4 15.4 5 5" /></>));
export const SearchEmpty = icon('SearchEmpty', () => (<><circle cx="10.6" cy="10.6" r="6.4" /><path d="m15.4 15.4 5 5M8.4 8.4l4.4 4.4M12.8 8.4l-4.4 4.4" /></>));
export const Plus = icon('Plus', () => <path d="M12 5v14M5 12h14" />);
export const PlusCircle = icon('PlusCircle', () => (<><circle cx="12" cy="12" r="8.6" /><path d="M12 8.2v7.6M8.2 12h7.6" /></>));
export const Close = icon('Close', () => <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />);
export const Check = icon('Check', () => <path d="m5 12.6 4.4 4.4L19 7.4" />);
export const CheckCircle = icon('CheckCircle', (f) => <circle cx="12" cy="12" r="8.6" fill={F(f)} />, () => <path d="m8.3 12.3 2.5 2.5 4.9-5" />);
export const Menu = icon('Menu', () => <path d="M4 7h16M4 12h16M4 17h16" />);
export const More = icon('More', () => (<><circle cx="12" cy="5.5" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="18.5" r="1.3" fill="currentColor" stroke="none" /></>));
export const Upload = icon('Upload', () => (<><path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9" /><path d="M4.5 14.5v3.5A2 2 0 0 0 6.5 20h11a2 2 0 0 0 2-2v-3.5" /></>));
export const Share = icon('Share', () => (<><path d="M14 4.5 20 10l-6 5.5v-3.2c-4.4 0-7.4 1.4-9.5 4.7.6-5 3.4-8.7 9.5-9.4z" /></>));
export const Link = icon('Link', () => (<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>));
export const ExternalLink = icon('ExternalLink', () => (<><path d="M13.5 4.5h6v6M19.5 4.5l-8 8" /><path d="M17 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h4" /></>));
export const Pencil = icon('Pencil', () => (<><path d="m14.6 5.4 4 4L9 19H5v-4z" /><path d="m12.8 7.2 4 4" /></>));
export const Trash = icon('Trash', () => (<><path d="M4.5 7h15M9.5 7V4.8h5V7" /><path d="M6.5 7l.9 11.4a2 2 0 0 0 2 1.8h5.2a2 2 0 0 0 2-1.8L17.5 7" /><path d="M10.2 11v5M13.8 11v5" /></>));
export const SignOut = icon('SignOut', () => (<><path d="M14 4.5H7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h7" /><path d="M16.5 8.5 20 12l-3.5 3.5M20 12H10" /></>));
export const Lock = icon('Lock', () => (<><rect x="5" y="10.5" width="14" height="9.5" rx="2.5" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>));
export const Globe = icon('Globe', () => (<><circle cx="12" cy="12" r="8.6" /><path d="M3.6 12h16.8M12 3.4c2.4 2.4 3.6 5.3 3.6 8.6s-1.2 6.2-3.6 8.6c-2.4-2.4-3.6-5.3-3.6-8.6S9.6 5.8 12 3.4z" /></>));
export const Mail = icon('Mail', () => (<><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="m4.5 7.5 7.5 5.5 7.5-5.5" /></>));
export const ImageAdd = icon('ImageAdd', () => (<><path d="M20 12.5V17a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17V7a2.5 2.5 0 0 1 2.5-2.5H12" /><path d="m4.5 16 4-4 3.5 3.5 2-2 3.5 3.5" /><path d="M18 3.5v5M15.5 6h5" /></>));
export const Flag = icon('Flag', (f) => (<><path d="M5.5 21V4.5" /><path d="M5.5 4.8c4-2 7 2 11.5 0v8.5c-4.5 2-7.5-2-11.5 0" fill={F(f)} /></>));
export const Pin = icon('Pin', (f) => (<><path d="M9 3.8h6l-.9 5.4 3.4 3.3H6.5l3.4-3.3z" fill={F(f)} /><path d="M12 12.5v7.7" /></>));
export const Comment = icon('Comment', (f) => <path d="M5.5 4.5h13a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7.3L7 20.6v-3.1H5.5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z" fill={F(f)} />);
export const Reply = icon('Reply', () => (<><path d="M9.5 6.5 4.5 11.5l5 5" /><path d="M4.5 11.5h9a6 6 0 0 1 6 6v1" /></>));
export const Sort = icon('Sort', () => <path d="M4 7h16M7 12h10M10 17h4" />);
export const Eye = icon('Eye', () => (<><path d="M2.8 12C5 7.8 8.2 5.7 12 5.7s7 2.1 9.2 6.3c-2.2 4.2-5.4 6.3-9.2 6.3S5 16.2 2.8 12z" /><circle cx="12" cy="12" r="2.8" /></>));
export const Clock = icon('Clock', () => (<><circle cx="12" cy="12" r="8.6" /><path d="M12 7.5V12l3 1.8" /></>));
export const Warning = icon('Warning', () => (<><path d="M10.4 4.6a1.8 1.8 0 0 1 3.2 0l7 12.6a1.8 1.8 0 0 1-1.6 2.7H5a1.8 1.8 0 0 1-1.6-2.7z" /><path d="M12 9.5v4M12 16.6v.1" /></>));
export const Scale = icon('Scale', () => (<><path d="M12 4v16M8 20h8M5.5 7.5h13" /><path d="m5.5 7.5-2.7 6.2a3 3 0 0 0 5.4 0zM18.5 7.5l-2.7 6.2a3 3 0 0 0 5.4 0z" /></>));
export const Copyright = icon('Copyright', () => (<><circle cx="12" cy="12" r="8.6" /><path d="M14.6 9.6a3.6 3.6 0 1 0 0 4.8" /></>));
export const Offline = icon('Offline', () => (<><path d="M7.2 18.5H6a4 4 0 0 1-.7-7.9A6.5 6.5 0 0 1 12 5.5c.8 0 1.6.1 2.3.4M18.6 9.6A4.5 4.5 0 0 1 17 18.5h-5.3" /><path d="m4 4 16 16" /></>));

/** Likes. Original hand-drawn shapes, outline for "not yet", filled when chosen. */
export const ThumbUp = icon('ThumbUp', (f) => (
  <>
    <path d="M8 10.2 11.4 4a2 2 0 0 1 3.6 1.5l-.8 3.4h4.3a2 2 0 0 1 2 2.4l-1.3 6.8a2.5 2.5 0 0 1-2.4 2H8z" fill={F(f)} />
    <rect x="3" y="10.2" width="5" height="9.9" rx="1.2" fill={F(f)} />
  </>
));
export const ThumbDown = icon('ThumbDown', (f) => (
  <>
    <path d="M16 13.8 12.6 20a2 2 0 0 1-3.6-1.5l.8-3.4H5.5a2 2 0 0 1-2-2.4l1.3-6.8a2.5 2.5 0 0 1 2.4-2H16z" fill={F(f)} />
    <rect x="16" y="3.9" width="5" height="9.9" rx="1.2" fill={F(f)} />
  </>
));

/** Badge for verified channels: a rounded seal with a tick. */
export const Verified = icon('Verified', () => (
  <path d="M12 2.8 14.3 4.4l2.8-.1.9 2.6 2.3 1.6-.9 2.6.9 2.6-2.3 1.6-.9 2.6-2.8-.1L12 19.4l-2.3-1.6-2.8.1-.9-2.6-2.3-1.6.9-2.6-.9-2.6 2.3-1.6.9-2.6 2.8.1z" fill="currentColor" stroke="none" transform="translate(0 0.9)" />
), () => <path d="m8.8 12.9 2.2 2.2 4.2-4.3" strokeWidth={1.9} />, true);

/* ---------- Player ---------- */

export const Play = icon('Play', () => <path d="M7.5 4.8v14.4a1 1 0 0 0 1.5.9l11.2-7.2a1 1 0 0 0 0-1.7L9 4a1 1 0 0 0-1.5.8z" fill="currentColor" />);
export const Pause = icon('Pause', () => (<><rect x="6" y="4.5" width="4" height="15" rx="1.3" fill="currentColor" /><rect x="14" y="4.5" width="4" height="15" rx="1.3" fill="currentColor" /></>));
export const VolumeOff = icon('VolumeOff', () => (<><path d="M4 9.5h3.2L12 5.2v13.6l-4.8-4.3H4z" fill="currentColor" /><path d="m16 9.5 5 5M21 9.5l-5 5" /></>));
export const VolumeLow = icon('VolumeLow', () => (<><path d="M4 9.5h3.2L12 5.2v13.6l-4.8-4.3H4z" fill="currentColor" /><path d="M15.5 9.3a3.8 3.8 0 0 1 0 5.4" /></>));
export const VolumeHigh = icon('VolumeHigh', () => (<><path d="M4 9.5h3.2L12 5.2v13.6l-4.8-4.3H4z" fill="currentColor" /><path d="M15.5 9.3a3.8 3.8 0 0 1 0 5.4M18.2 6.6a7.6 7.6 0 0 1 0 10.8" /></>));
export const Fullscreen = icon('Fullscreen', () => <path d="M4.5 9V5.5a1 1 0 0 1 1-1H9M15 4.5h3.5a1 1 0 0 1 1 1V9M19.5 15v3.5a1 1 0 0 1-1 1H15M9 19.5H5.5a1 1 0 0 1-1-1V15" />);
export const ExitFullscreen = icon('ExitFullscreen', () => <path d="M9 4.5V8a1 1 0 0 1-1 1H4.5M19.5 9H16a1 1 0 0 1-1-1V4.5M15 19.5V16a1 1 0 0 1 1-1h3.5M4.5 15H8a1 1 0 0 1 1 1v3.5" />);
export const Theater = icon('Theater', (f) => <rect x="2.5" y="6.5" width="19" height="11" rx="2" fill={F(f)} />);
export const MiniPlayer = icon('MiniPlayer', () => (<><rect x="3" y="5" width="18" height="14" rx="2.5" /><rect x="12" y="11.5" width="6.5" height="5" rx="1" fill="currentColor" /></>));

/* ---------- Devices and appearance ---------- */

export const Sun = icon('Sun', () => (<><circle cx="12" cy="12" r="3.8" /><path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4" /></>));
export const Moon = icon('Moon', () => <path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1z" />);
export const Monitor = icon('Monitor', () => (<><rect x="3" y="4.5" width="18" height="12" rx="2" /><path d="M9 20h6M12 16.5V20" /></>));
export const Laptop = icon('Laptop', () => (<><rect x="4.5" y="5" width="15" height="10.5" rx="1.8" /><path d="M2.5 19h19" /></>));
export const Phone = icon('Phone', () => (<><rect x="6.5" y="2.8" width="11" height="18.4" rx="2.6" /><path d="M11 18h2" /></>));

/* ---------- Navigation ---------- */

export const ChevronLeft = icon('ChevronLeft', () => <path d="m14.5 6-6 6 6 6" />);
export const ChevronRight = icon('ChevronRight', () => <path d="m9.5 6 6 6-6 6" />);
export const ChevronUp = icon('ChevronUp', () => <path d="m6 14.5 6-6 6 6" />);
export const ChevronDown = icon('ChevronDown', () => <path d="m6 9.5 6 6 6-6" />);
export const ArrowLeft = icon('ArrowLeft', () => <path d="M19 12H5M11 6l-6 6 6 6" />);

/** Activity indicator: a three-quarter ring, spun with `animate-spin`. */
export const Spinner = ({ size = 24, className, strokeWidth = 2.2 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeOpacity="0.2" strokeWidth={strokeWidth} />
    <path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
  </svg>
);

/* ---------- Free Me vocabulary ---------- */

/** Spark: public appreciation (in place of a thumbs-up). A four-point star. */
export const Spark = icon('Spark', (f) => <path d="M12 3.2l2 6.6 6.6 2.2-6.6 2.2-2 6.6-2-6.6L3.4 12l6.6-2.2z" fill={F(f)} />);
/** Not for me: private feedback to the creator. */
export const NotForMe = icon('NotForMe', (f) => (<><circle cx="12" cy="12" r="8.4" fill={F(f)} /><path d="M8.5 15.5c1.7-1.6 5.3-1.6 7 0" stroke={f ? 'var(--bg)' : 'currentColor'} /><path d="M9 9.8h.01M15 9.8h.01" strokeWidth={2.4} stroke={f ? 'var(--bg)' : 'currentColor'} /></>));
/** Pass along: share. An arrow leaving a bar. */
export const PassAlong = icon('PassAlong', () => (<><path d="M5 5v14" /><path d="M9 12h11M15 6.5l5.5 5.5-5.5 5.5" /></>));
/** Trail: watch history. A path between two points. */
export const Trail = icon('Trail', () => (<><path d="M5.5 18.5c3.2-.8 4.2-4 6.2-7s4.7-4.6 7-5" /><circle cx="5" cy="18.8" r="1.8" /><circle cx="19" cy="6.2" r="1.8" /></>));
