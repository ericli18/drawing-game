import type { ReactNode } from 'react'

export type SpellKind =
  | 'plus'
  | 'minus'
  | 'circle'
  | 'star'
  | 'triangle'
  | 'loop'

export interface SpellGlyphProps {
  spell: SpellKind
  label?: string
  className?: string
}

const GLYPHS: Record<SpellKind, ReactNode> = {
  plus: (
    <>
      <path d="M12 4.5v15" />
      <path d="M4.5 12h15" />
    </>
  ),
  minus: <path d="M4.5 12h15" />,
  circle: <circle cx="12" cy="12" r="7.5" />,
  star: (
    <path d="m12 3.5 2.5 5.1 5.7.8-4.1 4 1 5.6-5.1-2.7L6.9 19l1-5.6-4.1-4 5.7-.8L12 3.5Z" />
  ),
  triangle: <path d="m12 4 8 15H4l8-15Z" />,
  loop: (
    <>
      <path d="M16.7 15.7a7 7 0 1 1 0-9.9 7 7 0 0 1 0 9.9Z" />
      <path d="m16.8 15.8 3.7 3.7" />
    </>
  ),
}

export function SpellGlyph({ spell, label, className }: SpellGlyphProps) {
  const classes = `spell-glyph spell-glyph--${spell}${
    className ? ` ${className}` : ''
  }`

  return (
    <svg
      className={classes}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {GLYPHS[spell]}
    </svg>
  )
}
