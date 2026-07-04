import { Component, ReactNode } from "react";

// Without this, any uncaught render error anywhere in the tree unmounts the
// whole app, leaving just the root's dark background — indistinguishable
// from a real freeze/crash. This turns that into a recoverable message
// instead, and a reload button rather than forcing the user to relaunch.
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("MAHI crashed:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          gap: 14,
          background: "#0d1224",
          color: "#e8e8ea",
          fontFamily: "system-ui, sans-serif",
          padding: 24,
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600 }}>Something went wrong in MAHI's UI</div>
        <pre
          dir="ltr"
          style={{ fontSize: 11.5, opacity: 0.7, maxWidth: 640, whiteSpace: "pre-wrap", textAlign: "left" }}
        >
          {String(this.state.error?.message ?? this.state.error)}
        </pre>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: "8px 18px",
            borderRadius: 8,
            border: "1px solid #2a3560",
            background: "#1b2a6b",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
