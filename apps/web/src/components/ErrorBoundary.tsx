// SPDX-License-Identifier: Apache-2.0
/**
 * React Error Boundary — catches render-time JS exceptions and shows a
 * friendly fallback rather than a blank screen.
 *
 * Usage:
 *   <ErrorBoundary>
 *     <SomePage />
 *   </ErrorBoundary>
 *
 *   <ErrorBoundary fallback={<CustomError />}>
 *     <SomePage />
 *   </ErrorBoundary>
 */

import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children:   ReactNode;
  /** Custom fallback UI. Receives the caught error. */
  fallback?:  ReactNode | ((error: Error, reset: () => void) => ReactNode);
  /** Called after the error is caught — useful for logging to Sentry. */
  onError?:   (error: Error, info: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error:    Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
    // Log to console in dev
    if (process.env.NODE_ENV !== "production") {
      console.error("[ErrorBoundary]", error, info.componentStack);
    }
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    const { fallback } = this.props;
    const { error } = this.state;

    if (fallback) {
      return typeof fallback === "function"
        ? fallback(error!, this.reset)
        : fallback;
    }

    // Default fallback UI
    return (
      <div
        role="alert"
        style={{
          padding:    "2rem",
          maxWidth:   "600px",
          margin:     "2rem auto",
          fontFamily: "system-ui, sans-serif",
          border:     "1px solid #e53e3e",
          borderRadius: "8px",
          background: "#fff5f5",
        }}
      >
        <h2 style={{ color: "#c53030", marginTop: 0 }}>Something went wrong</h2>
        <p style={{ color: "#744210" }}>
          An unexpected error occurred. The team has been notified.
        </p>
        {process.env.NODE_ENV !== "production" && error && (
          <details style={{ marginTop: "1rem" }}>
            <summary style={{ cursor: "pointer", color: "#744210" }}>
              Error details (dev only)
            </summary>
            <pre
              style={{
                marginTop:  "0.5rem",
                padding:    "1rem",
                background: "#fff",
                border:     "1px solid #e53e3e",
                borderRadius: "4px",
                fontSize:   "0.75rem",
                overflow:   "auto",
                color:      "#c53030",
              }}
            >
              {error.stack ?? error.message}
            </pre>
          </details>
        )}
        <button
          onClick={this.reset}
          style={{
            marginTop:    "1.5rem",
            padding:      "0.5rem 1.25rem",
            background:   "#c53030",
            color:        "#fff",
            border:       "none",
            borderRadius: "4px",
            cursor:       "pointer",
            fontSize:     "0.875rem",
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;
