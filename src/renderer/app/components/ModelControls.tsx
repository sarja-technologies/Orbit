import { useEffect, useRef, useState } from 'react'
import type { ModelOption, ReasoningEffort } from '@shared/domain'
import { EFFORT_LABEL, compactModelLabel, descendingEfforts, isReasoningAdjustable } from '../lib/modelDisplay'
import { ReasoningSlider } from './ReasoningSlider'

interface ModelControlsProps {
  models: ModelOption[]
  selectedModel: string | null
  selectedEffort: ReasoningEffort | null
  fastMode: boolean
  disabled: boolean
  onChange: (model: string | null, effort: ReasoningEffort | null) => void
  onFastModeChange: (fastMode: boolean) => void
}

/** How many models the popover shows before "Other models…". Keeps the
 *  primary list short without ever hiding part of the real catalogue. */
const PRIMARY_COUNT = 5

/** One compact control in the composer footer that opens one popover:
 *  models on the left, reasoning on the right. Everything shown is real
 *  catalogue data — the reasoning side only exists when the selected model
 *  genuinely publishes more than one tier. */
export function ModelControls({
  models,
  selectedModel,
  selectedEffort,
  fastMode,
  disabled,
  onChange,
  onFastModeChange
}: ModelControlsProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const selected = models.find((model) => model.id === selectedModel) ?? null
  const efforts = descendingEfforts(selected)
  const adjustable = isReasoningAdjustable(selected)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const visibleModels = showAll ? models : models.slice(0, PRIMARY_COUNT)

  const selectModel = (id: string | null): void => {
    if (id === null) return onChange(null, null)
    const next = models.find((model) => model.id === id) ?? null
    // Carry the tier over only if the new model actually offers it.
    const keep = next?.supportedReasoningEfforts?.includes(selectedEffort as ReasoningEffort) ? selectedEffort : null
    onChange(id, keep)
  }

  return (
    <div className="model-control" ref={wrapperRef}>
      <button
        type="button"
        className="model-trigger"
        disabled={disabled || models.length === 0}
        aria-label="Model and reasoning"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={models.length === 0 ? 'Antigravity’s model list is unavailable' : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <OrbitMark />
        <span className="model-trigger-name">{selected ? compactModelLabel(selected.label) : 'Default model'}</span>
        {/* Meta state rides alongside the model at lower weight, with no
            divider glyphs between the parts. */}
        {selectedEffort ? (
          <span className="model-trigger-meta">
            <LevelGlyph />
            {EFFORT_LABEL[selectedEffort]}
          </span>
        ) : null}
        {fastMode ? (
          <span className="model-trigger-meta is-fast">
            <BoltGlyph />
            Fast mode
          </span>
        ) : null}
        <ChevronGlyph />
      </button>

      {open ? (
        <div className="model-popover" role="dialog" aria-label="Model and reasoning">
          <section className="popover-pane pane-models">
            <h3 className="pane-title">AI Model</h3>
            <div className="model-list">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={selectedModel === null}
                className={selectedModel === null ? 'model-option selected' : 'model-option'}
                onClick={() => selectModel(null)}
              >
                <span className="model-option-text">
                  <span className="model-option-name">Default model</span>
                  <span className="model-option-hint">Antigravity’s own choice</span>
                </span>
                <Tick checked={selectedModel === null} />
              </button>

              {visibleModels.map((model) => {
                const tiers = descendingEfforts(model)
                return (
                  <button
                    key={model.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={model.id === selectedModel}
                    className={model.id === selectedModel ? 'model-option selected' : 'model-option'}
                    onClick={() => selectModel(model.id)}
                  >
                    <span className="model-option-text">
                      <span className="model-option-name">{model.label}</span>
                      <span className="model-option-hint">
                        {tiers.length > 1
                          ? `${tiers.map((tier) => EFFORT_LABEL[tier]).join(' · ')} reasoning`
                          : tiers.length === 1
                            ? `${EFFORT_LABEL[tiers[0]!]} reasoning only`
                            : 'No reasoning setting'}
                      </span>
                    </span>
                    <Tick checked={model.id === selectedModel} />
                  </button>
                )
              })}
            </div>

            {models.length > PRIMARY_COUNT ? (
              <button type="button" className="model-more" onClick={() => setShowAll((value) => !value)}>
                <span>{showAll ? 'Show fewer' : 'Other models…'}</span>
                <ChevronGlyph />
              </button>
            ) : null}
          </section>

          {/* The reasoning pane exists only when there is a real choice to
              make; a single-tier or no-tier model states the fact instead of
              rendering an adjustable control that cannot move. */}
          <section className={adjustable ? 'popover-pane pane-reasoning' : 'popover-pane pane-reasoning is-fixed'}>
            <div className="pane-head">
              <h3 className="pane-title">Reasoning effort</h3>
              {adjustable ? <span className="pane-state">{selectedEffort ? EFFORT_LABEL[selectedEffort] : 'Auto'}</span> : null}
            </div>

            {adjustable ? (
              <ReasoningSlider
                model={selected}
                effort={selectedEffort}
                fastMode={fastMode}
                onChange={(effort) => onChange(selectedModel, effort)}
              />
            ) : (
              <p className="pane-note">
                {efforts.length === 1
                  ? `${selected?.label ?? 'This model'} runs at ${EFFORT_LABEL[efforts[0]!].toLowerCase()} reasoning only.`
                  : selected
                    ? `${selected.label} has no reasoning setting.`
                    : 'Choose a model to see its reasoning levels.'}
              </p>
            )}

            <button
              type="button"
              className={fastMode ? 'fast-mode active' : 'fast-mode'}
              aria-pressed={fastMode}
              onClick={() => onFastModeChange(!fastMode)}
            >
              <BoltGlyph />
              <span className="fast-mode-label">Fast mode</span>
              <span className="fast-mode-state">{fastMode ? 'On' : 'Off'}</span>
            </button>
            {/* Stated plainly rather than implied: agy 1.1.27 exposes no
                fast-mode flag, so this changes how the indicator moves and
                nothing about the request Orbit sends. */}
            <p className="fast-mode-note">Indicator only — Antigravity has no fast-mode setting yet.</p>
          </section>
        </div>
      ) : null}
    </div>
  )
}

function Tick({ checked }: { checked: boolean }): JSX.Element | null {
  if (!checked) return null
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" className="model-tick">
      <path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Orbit's own mark, rather than the sparkle every AI product reaches for. */
function OrbitMark(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false" className="orbit-mark">
      <circle cx="8" cy="8" r="3" fill="currentColor" />
      <ellipse cx="8" cy="8" rx="6.6" ry="3.1" stroke="currentColor" strokeWidth="1.1" fill="none" transform="rotate(-28 8 8)" opacity="0.75" />
    </svg>
  )
}

function LevelGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
      <path d="M3.5 11.5v-3M8 11.5v-6M12.5 11.5v-8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  )
}

function BoltGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
      <path d="M9 1.5L4 9h3.2l-.8 5.5L12 7H8.6z" fill="currentColor" />
    </svg>
  )
}

function ChevronGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false" className="chevron-glyph">
      <path d="M4 6.5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
