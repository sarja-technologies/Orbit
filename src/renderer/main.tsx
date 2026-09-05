import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { ErrorBoundary, StartupError } from './app/ErrorBoundary'
import './styles.css'

const root = document.getElementById('root')
if (!root) {
  const fallbackRoot = document.createElement('div')
  fallbackRoot.id = 'root'
  document.body.append(fallbackRoot)
  createRoot(fallbackRoot).render(<StartupError message="The renderer HTML did not include the #root element." />)
} else {
  createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  )
}
