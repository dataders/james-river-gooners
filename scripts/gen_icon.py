"""Generate apple-touch-icon.png + favicon.svg — Arsenal cannon + Richmond VA flag."""
import cairosvg, pathlib, textwrap

SVG = textwrap.dedent("""\
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180" width="180" height="180">
  <defs>
    <clipPath id="round">
      <rect width="180" height="180" rx="38" ry="38"/>
    </clipPath>
    <linearGradient id="bg-left" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="#c50005"/>
      <stop offset="100%" stop-color="#ef0107"/>
    </linearGradient>
    <linearGradient id="bg-right" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="#003087"/>
      <stop offset="100%" stop-color="#00247D"/>
    </linearGradient>
  </defs>

  <!-- Rounded background split: Arsenal red | Richmond blue -->
  <g clip-path="url(#round)">
    <rect x="0"  y="0" width="90"  height="180" fill="url(#bg-left)"/>
    <rect x="90" y="0" width="90"  height="180" fill="url(#bg-right)"/>

    <!-- Subtle diagonal divider -->
    <line x1="90" y1="0" x2="90" y2="180" stroke="white" stroke-width="1.5" opacity="0.25"/>

    <!-- Richmond VA — gold stars top-right quadrant -->
    <circle cx="118" cy="32" r="4"  fill="#C8A84B" opacity="0.9"/>
    <circle cx="140" cy="22" r="3"  fill="#C8A84B" opacity="0.8"/>
    <circle cx="158" cy="38" r="3.5" fill="#C8A84B" opacity="0.8"/>
    <circle cx="148" cy="52" r="2.5" fill="#C8A84B" opacity="0.7"/>

    <!-- Richmond VA — stylised river arc (James River) bottom-right -->
    <path d="M90 140 Q120 120 155 145 Q165 152 158 162 Q130 155 100 165 Q90 168 90 160 Z"
          fill="#C8A84B" opacity="0.18"/>
    <path d="M92 152 Q122 135 155 150" stroke="#C8A84B" stroke-width="2"
          fill="none" opacity="0.55" stroke-linecap="round"/>

    <!-- Arsenal — cannon body -->
    <!-- Barrel -->
    <rect x="44" y="83" width="92" height="18" rx="9" ry="9"
          fill="white" stroke="#C8A84B" stroke-width="2"/>
    <!-- Muzzle bell -->
    <ellipse cx="136" cy="92" rx="8" ry="11"
             fill="white" stroke="#C8A84B" stroke-width="2"/>
    <!-- Muzzle opening -->
    <ellipse cx="137" cy="92" rx="4.5" ry="7"
             fill="#ef0107"/>
    <!-- Barrel rings -->
    <rect x="58"  y="83" width="4" height="18" rx="2" fill="#C8A84B" opacity="0.7"/>
    <rect x="76"  y="83" width="4" height="18" rx="2" fill="#C8A84B" opacity="0.7"/>
    <rect x="96"  y="83" width="4" height="18" rx="2" fill="#C8A84B" opacity="0.7"/>
    <!-- Cannon base / cascabel -->
    <ellipse cx="48" cy="92" rx="6" ry="9"
             fill="white" stroke="#C8A84B" stroke-width="1.5"/>

    <!-- Carriage wheels -->
    <circle cx="66"  cy="112" r="12" fill="none" stroke="white" stroke-width="3.5"/>
    <circle cx="66"  cy="112" r="4"  fill="white"/>
    <line x1="66" y1="100" x2="66" y2="124" stroke="white" stroke-width="1.5"/>
    <line x1="54" y1="112" x2="78" y2="112" stroke="white" stroke-width="1.5"/>
    <line x1="57.5" y1="103.5" x2="74.5" y2="120.5" stroke="white" stroke-width="1.5"/>
    <line x1="74.5" y1="103.5" x2="57.5" y2="120.5" stroke="white" stroke-width="1.5"/>

    <circle cx="110" cy="112" r="12" fill="none" stroke="white" stroke-width="3.5"/>
    <circle cx="110" cy="112" r="4"  fill="white"/>
    <line x1="110" y1="100" x2="110" y2="124" stroke="white" stroke-width="1.5"/>
    <line x1="98"  y1="112" x2="122" y2="112" stroke="white" stroke-width="1.5"/>
    <line x1="101.5" y1="103.5" x2="118.5" y2="120.5" stroke="white" stroke-width="1.5"/>
    <line x1="118.5" y1="103.5" x2="101.5" y2="120.5" stroke="white" stroke-width="1.5"/>

    <!-- Axle bar between wheels -->
    <rect x="66" y="107" width="44" height="10" rx="5" fill="white" opacity="0.6"/>

    <!-- "GOONERS" label bottom centre -->
    <text x="90" y="171" text-anchor="middle"
          font-family="system-ui,-apple-system,sans-serif"
          font-size="13" font-weight="800" letter-spacing="2"
          fill="white" opacity="0.92">GOONERS</text>
  </g>

  <!-- Rounded border highlight -->
  <rect x="1" y="1" width="178" height="178" rx="37" ry="37"
        fill="none" stroke="white" stroke-width="2" opacity="0.15"/>
</svg>
""")

root = pathlib.Path(__file__).parent.parent / "public"

# PNG for apple-touch-icon
cairosvg.svg2png(bytestring=SVG.encode(), write_to=str(root / "apple-touch-icon.png"),
                 output_width=180, output_height=180)
print(f"Written {root / 'apple-touch-icon.png'}")

# SVG favicon (no rasterisation needed)
(root / "favicon.svg").write_text(SVG)
print(f"Written {root / 'favicon.svg'}")
