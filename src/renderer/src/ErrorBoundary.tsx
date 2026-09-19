import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Last-resort boundary: a renderer crash shows a readable panel instead of a
 * blank window, and never takes the host processes down with it.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("renderer crashed", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash">
        <h1>The interface crashed</h1>
        <p>Your sessions are safe — they live in the Pi profile, not in this window.</p>
        <pre>{error.stack ?? error.message}</pre>
        <button type="button" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
