import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import Landing from "./Landing";
import "./style.css";
const App = lazy(() => import("./App"));
const isWorkspace = /^\/(workspace|app)\/?$/i.test(window.location.pathname);
class Boundary extends React.Component<
  React.PropsWithChildren,
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main>
        <h1>RingTree could not load.</h1>
        <button onClick={() => location.reload()}>Reload dashboard</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <Boundary>
    {isWorkspace ? (
      <Suspense fallback={<main className="workspace-loading" role="status">Opening your workspace…</main>}>
        <App />
      </Suspense>
    ) : <Landing />}
  </Boundary>,
);
