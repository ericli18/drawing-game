import { SpellGlyph, type SpellKind } from './SpellGlyph'
import { SPELL_DESCRIPTIONS, SPELL_LABELS } from './spellLabels'

const SPELL_ORDER: readonly SpellKind[] = [
  'plus',
  'minus',
  'circle',
  'star',
  'triangle',
  'loop',
]

export type SpellPhase = 'ready' | 'active' | 'cooldown'

export type SpellRailState =
  | { phase: 'ready' }
  | {
      phase: 'active' | 'cooldown'
      remainingProgress: number
      remainingSeconds: number
    }

export type SpellRailStates = Partial<Record<SpellKind, SpellRailState>>

export interface PlayerVitalsProps {
  label: string
  health: number
  maxHealth?: number
  className?: string
}

export interface AmmoMeterProps {
  ammo: number
  maxAmmo?: number
  label?: string
  className?: string
}

export interface SpellRailProps {
  states?: SpellRailStates
  label?: string
  className?: string
}

const EMPTY_SPELL_STATES: SpellRailStates = {}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

function withClassName(baseClass: string, className?: string) {
  return className ? `${baseClass} ${className}` : baseClass
}

function formatSeconds(seconds: number) {
  return `${Math.ceil(Math.max(0, seconds))}s`
}

export function PlayerVitals({
  label,
  health,
  maxHealth = 100,
  className,
}: PlayerVitalsProps) {
  const safeMaxHealth = Math.max(1, maxHealth)
  const safeHealth = clamp(health, 0, safeMaxHealth)

  return (
    <section
      className={withClassName('player-vitals', className)}
      aria-label={`${label} health`}
    >
      <header className="player-vitals__header">
        <span className="player-vitals__label">{label}</span>
        <output className="player-vitals__value">
          {safeHealth} / {safeMaxHealth}
        </output>
      </header>
      <progress
        className="player-vitals__bar"
        value={safeHealth}
        max={safeMaxHealth}
        aria-label={`${label} health`}
      />
    </section>
  )
}

export function AmmoMeter({
  ammo,
  maxAmmo = 12,
  label = 'Ammo',
  className,
}: AmmoMeterProps) {
  const safeMaxAmmo = Math.max(1, Math.floor(maxAmmo))
  const safeAmmo = clamp(Math.floor(ammo), 0, safeMaxAmmo)

  return (
    <section
      className={withClassName('ammo-meter', className)}
      aria-label={label}
    >
      <header className="ammo-meter__header">
        <span className="ammo-meter__label">{label}</span>
        <output className="ammo-meter__value">
          {safeAmmo} / {safeMaxAmmo}
        </output>
      </header>
      <div
        className="ammo-meter__segments"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={safeMaxAmmo}
        aria-valuenow={safeAmmo}
        aria-valuetext={`${safeAmmo} of ${safeMaxAmmo} shots remaining`}
      >
        {Array.from({ length: safeMaxAmmo }, (_, index) => {
          const loaded = index < safeAmmo
          return (
            <span
              className={`ammo-meter__segment ammo-meter__segment--${
                loaded ? 'loaded' : 'empty'
              }`}
              data-loaded={loaded}
              aria-hidden="true"
              key={index}
            />
          )
        })}
      </div>
    </section>
  )
}

export function SpellRail({
  states = EMPTY_SPELL_STATES,
  label = 'Spells',
  className,
}: SpellRailProps) {
  return (
    <section
      className={withClassName('spell-rail', className)}
      aria-label={label}
    >
      <ol className="spell-rail__list">
        {SPELL_ORDER.map((spell) => {
          const state = states[spell] ?? { phase: 'ready' }
          const spellLabel = SPELL_LABELS[spell]
          const phaseLabel =
            state.phase === 'ready'
              ? SPELL_DESCRIPTIONS[spell]
              : `${state.phase === 'active' ? 'Active' : 'Cooldown'} · ${formatSeconds(
                  state.remainingSeconds,
                )}`

          return (
            <li
              className={`spell-rail__item spell-rail__item--${state.phase}`}
              data-spell={spell}
              data-phase={state.phase}
              key={spell}
            >
              <SpellGlyph
                className="spell-rail__glyph"
                spell={spell}
                label={`${spellLabel} spell`}
              />
              <span className="spell-rail__name">{spellLabel}</span>
              <span className="spell-rail__phase">{phaseLabel}</span>
              {state.phase === 'ready' ? null : (
                <progress
                  className="spell-rail__progress"
                  value={clamp(state.remainingProgress, 0, 1)}
                  max={1}
                  aria-label={`${spellLabel} ${state.phase} time remaining`}
                />
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
