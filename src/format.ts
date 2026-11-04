import { locale, plural } from "./i18n";

const nf = new Intl.NumberFormat(locale);
const df = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
const dtf = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** Decimal units with 3 significant digits, like Finder ("1,23 GB", "12,3 GB", "123 GB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${UNITS[0]}`;
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  if (i === 0) return `${nf.format(Math.round(v))} B`;
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v)} ${UNITS[i]}`;
}

export function formatNumber(n: number): string {
  return nf.format(n);
}

export function formatCount(noun: "item" | "file" | "folder", n: number): string {
  return `${nf.format(n)} ${plural(noun, n)}`;
}

export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return "–";
  const pct = fraction * 100;
  const digits = pct >= 10 || pct === 0 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(pct)}%`;
}

export function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return "—";
  return df.format(new Date(unixSeconds * 1000));
}

export function formatDateTime(unixSeconds: number): string {
  if (!unixSeconds) return "—";
  return dtf.format(new Date(unixSeconds * 1000));
}

const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

/** "3 days ago", "last month", "2 years ago". */
export function formatAgo(unixSeconds: number, now = Date.now() / 1000): string {
  const days = Math.max(0, (now - unixSeconds) / 86_400);
  if (days < 1) return rtf.format(0, "day");
  if (days < 30) return rtf.format(-Math.round(days), "day");
  if (days < 365) return rtf.format(-Math.round(days / 30.44), "month");
  return rtf.format(-Math.round(days / 365.25), "year");
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(s)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}

/** Replaces the home folder prefix with ~ for display. */
export function prettyPath(path: string, home: string | null): string {
  if (home && (path === home || path.startsWith(home + "/"))) return "~" + path.slice(home.length);
  return path;
}
