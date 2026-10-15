// Moving between pages of the app inside the shell (links, an agent's `pagent screen open`).

/**
 * Go to a page of the app. History entries count how deep into the app they are, so the shell offers "back" only when
 * there is a page of the app to go back to.
 */
export function go(url: string) {
  history.pushState({ depth: ((history.state as { depth?: number } | null)?.depth ?? 0) + 1 }, "", url);
  dispatchEvent(new PopStateEvent("popstate"));
}
