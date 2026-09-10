import { useEffect, useRef, useState } from 'react'
import type { ModelOption, ReasoningEffort } from '@shared/domain'
import { EFFORT_LABEL, compactModelLabel } from '../lib/modelDisplay'
import { reasoningTheme } from '../lib/reasoningVisual'
import { isGeminiModel, providerForModel } from '../lib/providers'
import { modelForSelection } from '@shared/reasoningPolicy'
import { ReasoningControl } from './ReasoningControl'
import { ModelBrowser, ModelRow, Tick } from './ModelBrowser'
import { AutoGlyph, ProviderLogo } from './ProviderLogo'

interface ModelControlsProps {
  models: ModelOption[]
  selectedModel: string | null
  selectedEffort: ReasoningEffort | null
  disabled: boolean
  /** Model and effort are separate intents: App resolves which tier a newly
   *  chosen model should land on from the user's remembered preference, and
   *  only an explicit tier click updates that preference. Collapsing both
   *  into one callback would make those indistinguishable. */
  onSelectModel: (model: string | null) => void
  onSelectEffort: (effort: ReasoningEffort) => void
}

/** One compact control in the composer footer that opens one popover:
 *  models on the left, reasoning on the right.
 *
 *  The popover lists Gemini only, because Antigravity is a Gemini workflow
 *  and dumping every vendor into a menu this size makes the common choice
 *  the hardest one. Everything else lives one click away behind "Other
 *  models…", which opens the full catalogue. */
export function ModelControls({
  models,
  selectedModel,
  selectedEffort,
  disabled,
  onSelectModel,
  onSelectEffort
}: ModelControlsProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const selected = models.find((model) => model.id === selectedModel) ?? null
  // Reasoning is asked of the selection, not the catalogue row: "Default
  // model" has real, selectable tiers even though it has no catalogue entry.
  const reasoningModel = modelForSelection(models, selectedModel)
  const theme = reasoningTheme(reasoningModel, selectedEffort)

  // The full browser is a modal and owns its own dismissal; the popover must
  // not also close on the clicks and Escapes happening inside it.
  useEffect(() => {
    if (!open || browsing) return
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
  }, [open, browsing])

  const geminiModels = models.filter(isGeminiModel)

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
        {selected ? <ProviderLogo provider={providerForModel(selected)} size={15} /> : <AutoGlyph />}
        <span className="model-trigger-name">{selected ? compactModelLabel(selected.label) : 'Default model'}</span>
        {/* The closed control carries the live tier in the same treatment the
            open control uses, so changing it is visible without reopening. */}
        {selectedEffort ? (
          <span className="model-trigger-effort" data-theme={theme}>
            {EFFORT_LABEL[selectedEffort]}
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
                className={selectedModel === null ? 'model-row selected' : 'model-row'}
                onClick={() => onSelectModel(null)}
              >
                <span className="model-row-mark model-row-mark-default" aria-hidden="true">
                  <AutoGlyph />
                </span>
                <span className="model-row-text">
                  <span className="model-row-name">Default model</span>
                  <span className="model-row-hint">Antigravity’s own choice</span>
                </span>
                <Tick checked={selectedModel === null} />
              </button>

              {geminiModels.map((model) => (
                <ModelRow key={model.id} model={model} selected={model.id === selectedModel} onSelect={() => onSelectModel(model.id)} />
              ))}
            </div>

            <button type="button" className="model-more" onClick={() => setBrowsing(true)}>
              <span>Other models…</span>
              <ChevronGlyph />
            </button>
          </section>

          {/* The reasoning pane always states something true: an adjustable
              control when there is a real choice, the fixed level when there
              is exactly one, and who owns the decision when there is none. */}
          <section className="popover-pane pane-reasoning">
            {/* No level badge here: the active stop below already states it,
                and a second copy only made the title wrap. */}
            <h3 className="pane-title">Reasoning effort</h3>

            <ReasoningControl model={reasoningModel} effort={selectedEffort} onChange={onSelectEffort} />

            {/* Kept visible because it is a real Antigravity concept, kept
                disabled because agy 1.1.27 exposes no fast-mode setting. It
                changes nothing anywhere while that is true. */}
            <div className="fast-mode" aria-disabled="true">
              <BoltGlyph />
              <span className="fast-mode-label">Fast mode</span>
              <span className="fast-mode-note">Not available in Antigravity yet</span>
            </div>
          </section>
        </div>
      ) : null}

      {browsing ? (
        <ModelBrowser
          models={models}
          selectedModel={selectedModel}
          onSelect={(modelId) => {
            setBrowsing(false)
            setOpen(false)
            onSelectModel(modelId)
          }}
          onClose={() => setBrowsing(false)}
        />
      ) : null}
    </div>
  )
}

function BoltGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
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
