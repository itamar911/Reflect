interface ReflectLogoProps {
  /** Rendered width in px; height scales proportionally */
  width?: number;
  /** Show the REFLECT wordmark below the mark */
  wordmark?: boolean;
}

/**
 * Brand mark: mirrored R (Я) + regular R overlapping, with optional REFLECT wordmark.
 *
 * Geometry (in viewBox units, font-size 120):
 *   Reversed R: x=9..79   Regular R: x=61..131   Overlap: x=61..79
 *   REFLECT text centred at x=70
 */
export function ReflectLogo({ width = 100, wordmark = true }: ReflectLogoProps) {
  const vW = 140;
  const vH = wordmark ? 140 : 107;
  const height = Math.round((width * vH) / vW);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${vW} ${vH}`}
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Reflect"
      role="img"
      style={{ direction: 'ltr' }}
    >
      {/* Reversed R — transform maps the glyph from x=9 to x=79, mirrored */}
      <text
        x="0"
        y="100"
        fontFamily="Georgia, 'Times New Roman', serif"
        fontSize="120"
        fill="#C4BAA8"
        transform="translate(79, 0) scale(-1, 1)"
      >
        R
      </text>

      {/* Regular R — overlaps the reversed R by ~18 px */}
      <text
        x="61"
        y="100"
        fontFamily="Georgia, 'Times New Roman', serif"
        fontSize="120"
        fill="#2C2418"
      >
        R
      </text>

      {/* REFLECT wordmark */}
      {wordmark && (
        <text
          x="70"
          y="132"
          fontFamily="Georgia, 'Times New Roman', serif"
          fontSize="15"
          fill="#7A6E5A"
          textAnchor="middle"
          letterSpacing="7"
        >
          REFLECT
        </text>
      )}
    </svg>
  );
}
