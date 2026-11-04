import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

const base = ({ size = 16, ...rest }: P) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.3,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  ...rest,
});

export const FolderIcon = (p: P) => (
  <svg {...base(p)} stroke="none">
    <path d="M1.5 4.2c0-.8.6-1.4 1.4-1.4h3.3l1.5 1.5h5.4c.8 0 1.4.6 1.4 1.4v6.6c0 .8-.6 1.4-1.4 1.4H2.9c-.8 0-1.4-.6-1.4-1.4z" fill="var(--icon-folder)" />
    <path d="M1.5 6h13v6.3c0 .8-.6 1.4-1.4 1.4H2.9c-.8 0-1.4-.6-1.4-1.4z" fill="var(--icon-folder-front)" />
  </svg>
);

export const PackageIcon = (p: P) => (
  <svg {...base(p)} stroke="none">
    <rect x="2" y="2" width="12" height="12" rx="3.2" fill="var(--icon-package)" />
    <path d="M5.2 10.8 8 5.2l2.8 5.6M6.1 9h3.8" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const FileIcon = (p: P) => (
  <svg {...base(p)} stroke="none">
    <path d="M4 1.8h5.2L12.6 5v8.6c0 .4-.3.6-.6.6H4c-.4 0-.6-.3-.6-.6V2.4c0-.4.3-.6.6-.6z" fill="var(--icon-file)" stroke="var(--icon-file-line)" strokeWidth=".8" />
    <path d="M9.2 1.8V5h3.4" fill="none" stroke="var(--icon-file-line)" strokeWidth=".8" />
  </svg>
);

export const LinkIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M6.8 9.2 9.2 6.8M7.6 4.6l.9-.9a2.4 2.4 0 0 1 3.4 3.4l-.9.9M8.4 11.4l-.9.9a2.4 2.4 0 0 1-3.4-3.4l.9-.9" />
  </svg>
);

export const DiskIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="1.8" y="4.2" width="12.4" height="7.6" rx="1.8" />
    <path d="M4.2 9.4h4" />
    <circle cx="11.6" cy="9.4" r=".5" fill="currentColor" />
  </svg>
);

export const ExternalDiskIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.2" y="1.8" width="9.6" height="12.4" rx="1.8" />
    <path d="M6 11.6h4" />
    <circle cx="8" cy="5.4" r="1.4" />
  </svg>
);

export const NetworkIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M1.8 8h12.4M8 1.8c1.8 1.9 2.6 4 2.6 6.2S9.8 12.3 8 14.2C6.2 12.3 5.4 10.2 5.4 8S6.2 3.7 8 1.8z" />
  </svg>
);

export const HomeIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M2.2 7.4 8 2.6l5.8 4.8" />
    <path d="M3.8 6.2v7.2h3V10h2.4v3.4h3V6.2" />
  </svg>
);

export const LockIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.4" y="7" width="9.2" height="6.8" rx="1.4" />
    <path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" />
  </svg>
);

export const CloudIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M4.6 12.6h7a2.8 2.8 0 0 0 .3-5.6 4 4 0 0 0-7.7-.6A3.1 3.1 0 0 0 4.6 12.6z" />
  </svg>
);

export const ChevronRight = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </svg>
);

export const ArrowUpIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 13V3.4M3.8 7.4 8 3.2l4.2 4.2" />
  </svg>
);

export const SparklesIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M6.4 2.2 7.5 5.3l3.1 1.1-3.1 1.1-1.1 3.1-1.1-3.1-3.1-1.1 3.1-1.1z" />
    <path d="M11.8 9.4l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6z" />
  </svg>
);

export const ChevronLeft = (p: P) => (
  <svg {...base(p)}>
    <path d="M10 3.5 5.5 8l4.5 4.5" />
  </svg>
);

export const RefreshIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8" />
    <path d="M13.2 2.6v2.8h-2.8" />
  </svg>
);

export const StopIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="4" y="4" width="8" height="8" rx="1.6" fill="currentColor" stroke="none" />
  </svg>
);

export const WarningIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 2.2 14.4 13.4H1.6z" />
    <path d="M8 6.4v3.2" />
    <circle cx="8" cy="11.5" r=".4" fill="currentColor" />
  </svg>
);

export const InfoIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M8 7.4v3.8" />
    <circle cx="8" cy="5" r=".45" fill="currentColor" />
  </svg>
);

export const EyeIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M1.6 8S4 3.6 8 3.6 14.4 8 14.4 8 12 12.4 8 12.4 1.6 8 1.6 8z" />
    <circle cx="8" cy="8" r="2" />
  </svg>
);

export const TrashIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M2.8 4.2h10.4M6.2 4.2V2.8h3.6v1.4M4 4.2l.7 9.2c0 .4.4.8.8.8h5c.4 0 .8-.4.8-.8l.7-9.2" />
  </svg>
);

export const FinderIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="1.8" y="1.8" width="12.4" height="12.4" rx="3" />
    <path d="M8 1.8c-1 2.2-1.4 4.2-1.4 6.6H8v5.8M5 5.6v1M11 5.6v1M4.6 10.4c2 1.4 4.8 1.4 6.8 0" />
  </svg>
);

export const CopyIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="5.2" y="5.2" width="8.6" height="8.6" rx="1.6" />
    <path d="M10.8 5.2V3.6c0-.9-.7-1.6-1.6-1.6H3.6C2.7 2 2 2.7 2 3.6v5.6c0 .9.7 1.6 1.6 1.6h1.6" />
  </svg>
);

export const TargetIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="6" />
    <circle cx="8" cy="8" r="2.6" />
  </svg>
);

export const OpenIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M9.4 2.4h4.2v4.2M13.6 2.4 7.6 8.4M11.6 9.4v3.2c0 .6-.4 1-1 1H3.4c-.6 0-1-.4-1-1V5.4c0-.6.4-1 1-1h3.2" />
  </svg>
);

export const FolderPlusIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M1.8 4.4c0-.7.6-1.3 1.3-1.3h3l1.4 1.4h5.4c.7 0 1.3.6 1.3 1.3v6.6c0 .7-.6 1.3-1.3 1.3H3.1c-.7 0-1.3-.6-1.3-1.3z" />
    <path d="M8 7.2v3.6M6.2 9h3.6" />
  </svg>
);

/** App mark: a tiny ring chart. */
export const LogoMark = ({ size = 56 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
    <circle cx="32" cy="32" r="9.5" fill="var(--chart-center-css)" />
    {[
      [0, 0.42, 205],
      [0.42, 0.7, 290],
      [0.7, 0.88, 20],
      [0.88, 1, 140],
    ].map(([a, b, h], i) => (
      <path key={i} d={arcPath(32, 32, 11.5, 21, a, b)} fill={`hsl(${h} 70% 54%)`} />
    ))}
    {[
      [0, 0.25, 205],
      [0.25, 0.38, 240],
      [0.42, 0.6, 285],
      [0.7, 0.8, 15],
      [0.88, 0.96, 140],
    ].map(([a, b, h], i) => (
      <path key={`o${i}`} d={arcPath(32, 32, 22.5, 30, a, b)} fill={`hsl(${h} 70% 66%)`} />
    ))}
  </svg>
);

function arcPath(cx: number, cy: number, r0: number, r1: number, f0: number, f1: number): string {
  const gap = 0.012;
  const a0 = (f0 + gap / 2) * Math.PI * 2 - Math.PI / 2;
  const a1 = (f1 - gap / 2) * Math.PI * 2 - Math.PI / 2;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  return `M${p(r1, a0)} A${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L${p(r0, a1)} A${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}
