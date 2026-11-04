const pages = ['explore', 'search', 'shorts', 'subscriptions', 'studio', 'upload', 'account', 'advertiser', 'admin'] as const;
type Page = typeof pages[number];

export type Route =
  | { view: 'home' | 'not-found' | Exclude<Page, 'search'> }
  | { view: 'search'; query: string }
  | { view: 'watch' | 'channel'; id: string };

export function readRoute(location: Pick<Location, 'pathname' | 'search'>): Route {
  const path = location.pathname.replace(/\/$/, '');
  const params = new URLSearchParams(location.search);
  if (!path) return { view: 'home' };
  if (path === '/search') return { view: 'search', query: params.get('q') || '' };
  if (path === '/watch' || path === '/channel') {
    const id = params.get(path === '/watch' ? 'v' : 'id');
    if (id) return { view: path === '/watch' ? 'watch' : 'channel', id };
  }
  const page = pages.find((item) => '/' + item === path);
  return { view: page && page !== 'search' ? page : 'not-found' };
}

export function pageUrl(view: string, value?: string): string {
  if (view === 'home') return '/';
  const key = view === 'watch' ? 'v' : view === 'channel' ? 'id' : 'q';
  return '/' + view + (value ? '?' + new URLSearchParams({ [key]: value }) : '');
}
