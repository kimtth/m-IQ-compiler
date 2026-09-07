/**
 * The product mark.
 *
 * A rounded square carrying the violet → sky gradient, drawn as vector rather
 * than shipped as a bitmap: the rail renders it at 28px and a packaged app has
 * no second size to fall back on. It is transparent outside the squircle — the
 * gradient is the mark, so nothing behind it should be painted. Anything
 * placing it must not add a background, a border or a shadow.
 *
 * The gradient id is scoped per instance. Two marks on one page with the same
 * id would both resolve to whichever definition the document parsed first.
 */

let seq = 0;

export function Logo({ size = 28 }: { size?: number }): JSX.Element {
  const id = `logo-gradient-${(seq += 1)}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="IQ Compiler"
      focusable="false"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b7cf0" />
          <stop offset="0.55" stopColor="#6e93e8" />
          <stop offset="1" stopColor="#56a9dd" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="64" height="64" rx="18" ry="18" fill={`url(#${id})`} />
    </svg>
  );
}
