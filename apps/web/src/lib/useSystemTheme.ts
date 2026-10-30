import { useEffect, useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

const QUERY = '(prefers-color-scheme: dark)';

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function getSnapshot(): Theme {
  return window.matchMedia(QUERY).matches ? 'dark' : 'light';
}

/**
 * Follows the OS colour scheme: returns the current theme and keeps the `dark` class on
 * `<html>` in sync with it (the shadcn theme variables switch on that class).
 */
export function useSystemTheme(): Theme {
  const theme = useSyncExternalStore(subscribe, getSnapshot, () => 'light' as const);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);
  return theme;
}
