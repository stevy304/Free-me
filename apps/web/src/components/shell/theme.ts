'use client';

export type ThemeChoice = 'system' | 'light' | 'dark';

/** Applies and remembers the theme (cookie, so the server renders the right one on the next visit). */
export function setTheme(choice: ThemeChoice) {
  document.cookie = `fm_theme=${choice}; path=/; max-age=31536000; samesite=lax`;
  const dark = choice === 'dark' || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

export function currentTheme(): ThemeChoice {
  const m = /(?:^|; )fm_theme=(light|dark|system)/.exec(document.cookie);
  return (m?.[1] as ThemeChoice) ?? 'system';
}
