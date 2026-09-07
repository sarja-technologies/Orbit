import { useEffect, useRef, useState } from 'react'
import type { ModelOption, ReasoningEffort } from '@shared/domain'

interface ModelControlsProps {
  models: ModelOption[]
  selectedModel: string | null
  selectedEffort: ReasoningEffort | null
  disabled: boolean
  onChange: (model: string | null, effort: ReasoningEffort | null) => void
}

const EFFORT_LABEL: Record<ReasoningEffort, string> = { low: 'Low', medium: 'Medium', high: 'High' }

/** Model and reasoning pickers, sitting on the composer's footer row.
 *  Everything shown here comes from Antigravity's real catalogue: the
 *  reasoning control only exists when the selected model genuinely lists
 *  tier variants, and no tier is ever pre-selected on the user's behalf. */
export function ModelControls({ models, selectedModel, selectedEffort, disabled, onChange }: ModelControlsProps): JSX.Element {
  const selected = models.find((model) => model.id === selectedModel) ?? null
  const efforts = selected?.supportedReasoningEfforts ?? []

  return (
    <div className="composer-meta">
      <span className="composer-provider">Antigravity</span>
      <span className="composer-sep" aria-hidden="true">·</span>

      <Menu
        label={selected?.label ?? 'Default model'}
        disabled={disabled || models.length === 0}
        ariaLabel="Model"
        title={models.length === 0 ? 'Antigravity’s model list is unavailable' : undefined}
        items={[
          { id: '__default__', label: 'Default model', hint: 'Antigravity’s own default', selected: selectedModel === null },
          ...models.map((model) => ({
            id: model.id,
            label: model.label,
            hint: model.supportedReasoningEfforts ? `${model.supportedReasoningEfforts.length} reasoning levels` : 'No reasoning levels',
            selected: model.id === selectedModel
          }))
        ]}
        onSelect={(id) => {
          if (id === '__default__') return onChange(null, selectedEffort)
          const next = models.find((model) => model.id === id) ?? null
          // Drop an effort the newly chosen model does not actually offer,
          // rather than carrying over a tier it would reject.
          const keep = next?.supportedReasoningEfforts?.includes(selectedEffort as ReasoningEffort) ? selectedEffort : null
          onChange(id, keep)
        }}
      />

      {/* Only rendered when this model really has tiers — a model with none
          must not appear to offer a reasoning choice. */}
      {efforts.length > 0 ? (
        <>
          <span className="composer-sep" aria-hidden="true">·</span>
          <Menu
            label={selectedEffort ? EFFORT_LABEL[selectedEffort] : 'Default effort'}
            disabled={disabled}
            ariaLabel="Reasoning effort"
            items={[
              { id: '__default__', label: 'Default effort', hint: 'Antigravity decides', selected: selectedEffort === null },
              ...efforts.map((effort) => ({ id: effort, label: EFFORT_LABEL[effort], selected: effort === selectedEffort }))
            ]}
            onSelect={(id) => onChange(selectedModel, id === '__default__' ? null : (id as ReasoningEffort))}
          />
        </>
      ) : null}
    </div>
  )
}

interface MenuItem {
  id: string
  label: string
  hint?: string
  selected: boolean
}

function Menu({
  label,
  items,
  disabled,
  ariaLabel,
  title,
  onSelect
}: {
  label: string
  items: MenuItem[]
  disabled: boolean
  ariaLabel: string
  title?: string | undefined
  onSelect: (id: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

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

  return (
    <div className="meta-menu" ref={wrapperRef}>
      <button
        type="button"
        className="meta-trigger"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        title={title}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{label}</span>
        <ChevronGlyph />
      </button>
      {open ? (
        <div className="menu menu-up" role="menu">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.selected}
              className={item.selected ? 'menu-item selected' : 'menu-item'}
              onClick={() => {
                setOpen(false)
                onSelect(item.id)
              }}
            >
              <span className="menu-item-label">{item.label}</span>
              {item.hint ? <span className="menu-item-hint">{item.hint}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ChevronGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
      <path d="M4 6.5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
