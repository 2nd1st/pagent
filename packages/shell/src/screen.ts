// The shell's half of the screen relay: report what this tab shows, and run the agent's jobs from the event stream.
import { api, clientId, onHostEvent } from "./host.ts";
import { presence, runJob, trackTouches } from "./screen-dom.ts";

function report() {
  void api("/api/presence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: clientId, ...presence() }),
  }).catch(() => {});
}

const navigate = (path: string) => {
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
};

export function startScreenRelay() {
  report();
  setInterval(report, 15_000);
  document.addEventListener("visibilitychange", report);
  addEventListener("popstate", () => setTimeout(report, 500));
  trackTouches(report);
  new MutationObserver(() => {
    clearTimeout((report as any).t);
    (report as any).t = setTimeout(report, 800);
  }).observe(document.body, { childList: true, subtree: true });

  onHostEvent(async (e: any) => {
    if (e.type === "screen" && e.clientId === clientId) {
      const text = await runJob(e.node, e.job, navigate);
      void api("/api/screen-result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: e.id, text }) }).catch(() => {});
    }
    if (e.type === "resync") report(); // the server may have restarted and forgotten us
  });
}
