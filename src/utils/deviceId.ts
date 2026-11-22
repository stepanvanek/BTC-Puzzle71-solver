import type { Locale } from '../i18n/locale.ts';
import { pathnameForTab } from '../i18n/locale.ts';

let runtimeDeviceId: string | null = null;
let runtimeDeviceSecret: string | null = null;

function generateRandomHex(byteLength: number): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint8Array(byteLength);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.padEnd(
    byteLength * 2,
    '0',
  );
}

export function getOrCreateDeviceId(): string {
  if (runtimeDeviceId) return runtimeDeviceId;
  runtimeDeviceId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `dev-${generateRandomHex(12)}`;
  return runtimeDeviceId;
}

export function getOrCreateDeviceSecret(): string {
  if (runtimeDeviceSecret) return runtimeDeviceSecret;
  runtimeDeviceSecret = generateRandomHex(24);
  return runtimeDeviceSecret;
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
