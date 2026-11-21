import type { Locale } from '../i18n/locale.ts';
import { pathnameForTab } from '../i18n/locale.ts';

const DEVICE_ID_KEY = 'puzzle71_device_id_v1';

export function getOrCreateDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing && existing.length >= 8) return existing;
    const generated =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `dev-${Math.random().toString(36).slice(2, 12)}`;
    localStorage.setItem(DEVICE_ID_KEY, generated);
    return generated;
  } catch {
    return `dev-${Math.random().toString(36).slice(2, 12)}`;
  }
}

export function detectDeviceLabel(locale: Locale = 'en'): string {
  if (typeof navigator === 'undefined') return locale === 'cs' ? 'Prohlížeč' : 'Browser';
  const ua = navigator.userAgent;
  const isMobile = /Android|iPhone|iPad|Mobile/i.test(ua);
  const browser = /Edg/i.test(ua)
    ? 'Edge'
    : /Chrome/i.test(ua)
      ? 'Chrome'
      : /Firefox/i.test(ua)
        ? 'Firefox'
        : /Safari/i.test(ua)
          ? 'Safari'
          : locale === 'cs'
            ? 'Prohlížeč'
            : 'Browser';
  const platform = isMobile ? (locale === 'cs' ? 'Mobil' : 'Mobile') : 'Desktop';
  return `${platform} · ${browser}`;
}

export function buildShareableSessionUrl(shareToken: string, locale: Locale = 'en'): string {
  if (typeof window === 'undefined') return `?u=${shareToken}`;
  const url = new URL(window.location.href);
  url.pathname = pathnameForTab('compute', locale);
  url.search = `?u=${encodeURIComponent(shareToken)}`;
  return url.toString();
}
