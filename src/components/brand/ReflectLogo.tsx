interface ReflectLogoProps {
  width?: number;
  wordmark?: boolean;
}

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
      {/* Reversed Я */}
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

      {/* Regular R */}
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
          fontSize="13"
          fill="#7A6E5A"
          textAnchor="middle"
          letterSpacing="6"
        >
          REFLECT
        </text>
      )}
    </svg>
  );
}
