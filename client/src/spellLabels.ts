import type { SpellKind } from './SpellGlyph'

export const SPELL_LABELS: Record<SpellKind, string> = {
  plus: 'Rapid fire',
  minus: 'Slow',
  circle: 'Shield',
  star: 'Blind',
  triangle: 'Reflect',
  loop: 'Reload',
}

export const SPELL_DESCRIPTIONS: Record<SpellKind, string> = {
  plus: 'Shoot faster',
  minus: 'Slow rival fire',
  circle: 'Block shots',
  star: 'Blind rival',
  triangle: 'Reflect shots',
  loop: 'Refill ammo',
}
