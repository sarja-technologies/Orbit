import React from 'react'

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('Orbit renderer failed to render.', error, errorInfo.componentStack)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return <StartupError message={this.state.error.message} detail={this.state.error.stack} />
    }

    return this.props.children
  }
}

export function StartupError({ message, detail }: { message: string; detail?: string | undefined }): JSX.Element {
  return (
    <main className="startup-error" role="alert">
      <section>
        <p className="startup-kicker">Startup error</p>
        <h1>Orbit failed to start</h1>
        <p>{message || 'An unexpected renderer error occurred.'}</p>
        {detail ? <pre>{detail}</pre> : null}
      </section>
    </main>
  )
}
