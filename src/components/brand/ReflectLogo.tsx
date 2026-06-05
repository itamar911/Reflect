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
      <defs>
        <linearGradient id="rGold" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor="#e8d5a3" />
          <stop offset="40%"  stopColor="#c9a84c" />
          <stop offset="70%"  stopColor="#a07830" />
          <stop offset="100%" stopColor="#c9a84c" />
        </linearGradient>
        <linearGradient id="rMirror" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor="#d4c89a" stopOpacity="0.85" />
          <stop offset="40%"  stopColor="#b8923e" stopOpacity="0.85" />
          <stop offset="70%"  stopColor="#8a6525" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#b8923e" stopOpacity="0.85" />
        </linearGradient>
      </defs>

      {/* Reversed Я */}
      <text
        x="0"
        y="100"
        fontFamily="Georgia, 'Times New Roman', serif"
        fontSize="120"
        fill="url(#rMirror)"
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
        fill="url(#rGold)"
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
          fill="#c9a84c"
          textAnchor="middle"
          letterSpacing="6"
        >
          REFLECT
        </text>
      )}
    </svg>
  );
}
