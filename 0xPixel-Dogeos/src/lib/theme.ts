import {useCallback, useEffect, useLayoutEffect, useState} from 'react';

type Theme = 'light' | 'dark';
const STORAGE_KEY = 'dogeos-pixel-theme';
const SYSTEM_QUERY = '(prefers-color-scheme: dark)';
const isTheme = (value: string | null): value is Theme => value === 'light' || value === 'dark';

function savedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

export function useTheme() {
  const [preference, setPreference] = useState<Theme | null>(savedTheme);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(SYSTEM_QUERY).matches);
  const theme: Theme = preference ?? (systemDark ? 'dark' : 'light');

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#171a16' : '#f4c542');
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia(SYSTEM_QUERY);
    const onSystemChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    const onStorageChange = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) {
        setPreference(isTheme(event.newValue) ? event.newValue : null);
      }
    };
    media.addEventListener('change', onSystemChange);
    window.addEventListener('storage', onStorageChange);
    return () => {
      media.removeEventListener('change', onSystemChange);
      window.removeEventListener('storage', onStorageChange);
    };
  }, []);

  const toggleTheme = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setPreference(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The selection still works for this session when storage is unavailable.
    }
  }, [theme]);

  return {theme, toggleTheme};
}
