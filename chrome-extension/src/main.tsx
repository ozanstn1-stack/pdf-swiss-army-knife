import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// The desktop font stack is Windows oriented; the extension runs in Chrome on
// any platform, so keep a generic fallback list.
document.body.style.fontFamily = '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", sans-serif';

// `?selftest=1` runs the browser-side integration checks (used by automation
// and by anyone who wants to verify the toolkit in their own browser).
const params = new URLSearchParams(location.search);
if (params.has("selftest")) {
  void import("./lib/selftest").then(({ runSelfTest }) => runSelfTest());
} else {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
