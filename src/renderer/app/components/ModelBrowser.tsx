import { useMemo, useState } from 'react'
import type { ModelOption } from '@shared/domain'
import { groupByProvider, matchesQuery } from '../lib/providers'
import { describeModel } from '../lib/modelDescriptions'
import { Modal, ModalHeader } from './Modal'
import { ProviderLogo } from './ProviderLogo'
import { isOrbitDefaultModel, resolveModelId } from '@shared/defaultModel'

interface ModelBrowserProps {
  models: ModelOption[]
  selectedModel: string | null
  onSelect: (modelId: string | null) => void
  onClose: () => void
}

/** Below this the catalogue fits on screen and a search field is pure
 *  chrome; above it, scanning starts to cost something. */
const SEARCH_THRESHOLD = 10

/** The full catalogue, grouped by the provider each model actually comes
 *  from. Everything here is the real normalized `agy models` output — there
 *  is no placeholder row and no invented model. */
export function ModelBrowser({ models, selectedModel, onSelect, onClose }: ModelBrowserProps): JSX.Element {
  const [query, setQuery] = useState('')
  const searchable = models.length >= SEARCH_THRESHOLD
  const groups = useMemo(
    () => groupByProvider(searchable ? models.filter((model) => matchesQuery(model, query)) : models),
    [models, query, searchable]
  )

  return (
    <Modal label="All models" wide onClose={onClose}>
      <ModalHeader title="All models" onClose={onClose}>
        {searchable ? (
          <input
            className="modal-search"
            type="search"
            value={query}
            placeholder="Search models"
            aria-label="Search models"
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : null}
      </ModalHeader>

      <div className="modal-body model-browser">
        {groups.map((group) => (
          <section key={group.provider.key} className="model-group">
            <h3 className="model-group-title">
              <ProviderLogo provider={group.provider.key} size={14} />
              {group.provider.label}
            </h3>
            {group.models.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                selected={model.id === resolveModelId(selectedModel)}
                isDefault={isOrbitDefaultModel(model.id)}
                onSelect={() => onSelect(model.id)}
              />
            ))}
          </section>
        ))}

        {groups.length === 0 ? (
          <p className="modal-empty">{models.length === 0 ? 'Antigravity’s model list is unavailable.' : `No models match “${query}”.`}</p>
        ) : null}
      </div>
    </Modal>
  )
}

export function ModelRow({
  model,
  selected,
  isDefault = false,
  onSelect
}: {
  model: ModelOption
  selected: boolean
  /** Marks the row as Orbit's default. Purely a label: the row still
   *  selects this model's own real id, never a sentinel. */
  isDefault?: boolean
  onSelect: () => void
}): JSX.Element {
  const provider = groupByProvider([model])[0]!.provider
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={selected ? 'model-row selected' : 'model-row'}
      onClick={onSelect}
    >
      <span className="model-row-mark" aria-hidden="true">
        <ProviderLogo provider={provider.key} size={17} />
      </span>
      <span className="model-row-text">
        <span className="model-row-name">
          {model.label}
          {isDefault ? <span className="model-row-default">Default</span> : null}
        </span>
        {/* What this model is for — never its reasoning tiers, which are a
            separate, adjustable setting with their own control. */}
        <ModelHint parts={describeModel(model).parts} />
      </span>
      <Tick checked={selected} />
    </button>
  )
}

export function Tick({ checked }: { checked: boolean }): JSX.Element | null {
  if (!checked) return null
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" className="model-tick">
      <path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The description line under a model's name. The separator lives here so
 *  a one-part description never renders a dangling dot. */
export function ModelHint({ parts }: { parts: string[] }): JSX.Element | null {
  if (parts.length === 0) return null
  return (
    <span className="model-row-hint" title={parts.join(' • ')}>
      {parts.map((part, index) => (
        <span key={part}>
          {index > 0 ? <span className="model-row-hint-sep" aria-hidden="true"> • </span> : null}
          {part}
        </span>
      ))}
    </span>
  )
}
