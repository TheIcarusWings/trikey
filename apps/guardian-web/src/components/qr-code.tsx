import { useMemo } from 'react';
import QRCode from 'qrcode';

interface QrCodeProps {
  value: string;
  /** Rendered size in px, quiet zone excluded. */
  size: number;
  label: string;
}

/**
 * Renders a QR code locally as one SVG path. Always dark on white, whatever the
 * theme, because scanners need the contrast. Nothing leaves the browser.
 */
export function QrCode({ value, size, label }: QrCodeProps) {
  const { count, path } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    const data = qr.modules.data;
    let d = '';
    for (let y = 0; y < n; y++) {
      let x = 0;
      while (x < n) {
        if (data[y * n + x]) {
          let run = 1;
          while (x + run < n && data[y * n + x + run]) run++;
          d += `M${x} ${y}h${run}v1h-${run}z`;
          x += run;
        } else {
          x++;
        }
      }
    }
    return { count: n, path: d };
  }, [value]);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${count} ${count}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className="block max-w-full"
    >
      <rect width={count} height={count} fill="#ffffff" />
      <path d={path} fill="#09090b" />
    </svg>
  );
}
