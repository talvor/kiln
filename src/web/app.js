// The Dashboard's page script: the Needs you list, kept live by one Server-Sent Events stream.
// Everything an agent wrote reaches the page through textContent, never as markup.
"use strict";
(() => {
  const rail = document.getElementById("rail");
  const main = document.getElementById("main");
  const banner = document.getElementById("banner");
  const favicon = document.getElementById("favicon");
  let view = { running: true, count: 0, groups: [], stale: [] };
  let problem = null;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function age(iso) {
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + " min";
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return hours + " h";
    return Math.floor(hours / 24) + " d";
  }

  const selectedId = () => {
    const match = /^\/escalations\/(\d+)$/.exec(location.pathname);
    return match ? Number(match[1]) : null;
  };

  function go(path) {
    if (path !== location.pathname) history.pushState(null, "", path);
    render(); // swap the main area: no page load
  }

  function row(item, isStale) {
    const selected = selectedId() === item.id;
    const node = el("button", "row" + (selected ? " selected" : "") + (isStale ? " stale" : ""));
    node.type = "button";
    const request = item.requestId === null ? "no Request" : "Request " + item.requestId;
    const kind = item.gate === null ? "question" : item.gate;
    node.append(
      el(
        "div",
        "meta",
        kind + " · " + request + " · " + age(item.createdAt) + (isStale ? " · stale" : ""),
      ),
      el("div", "summary", item.summary),
    );
    if (selected && item.detail) node.append(el("pre", "detail", item.detail)); // the row expands
    node.addEventListener("click", () => go("/escalations/" + item.id));
    return node;
  }

  function renderRail() {
    rail.replaceChildren(el("h2", "", "Needs you"));
    if (view.groups.length === 0) rail.append(el("p", "empty", "Nothing is waiting on you."));
    for (const group of view.groups) {
      rail.append(el("h3", "", group.project === null ? "No Project" : group.project));
      for (const item of group.items) rail.append(row(item, false));
    }
    if (view.stale.length > 0) {
      rail.append(el("h2", "", "Stale"));
      rail.append(el("p", "empty", "Their Request ended, so they cannot be acted on."));
      for (const item of view.stale) rail.append(row(item, true));
    }
  }

  function renderMain() {
    main.replaceChildren();
    if (problem) return main.append(el("p", "note", problem));
    const id = selectedId();
    if (id === null) return main.append(el("p", "note", "Pick an Escalation to see its detail."));
    const all = [...view.groups.flatMap((g) => g.items), ...view.stale];
    const item = all.find((i) => i.id === id);
    if (!item) return main.append(el("p", "note", "Escalation " + id + " is not waiting on you."));
    const stale = view.stale.includes(item);
    main.append(
      el("h2", "", "Escalation " + item.id + (stale ? " (stale)" : "")),
      el(
        "p",
        "meta",
        (item.gate === null ? "question" : item.gate) + " · " +
          (item.requestId === null ? "no Request" : "Request " + item.requestId) +
          (item.project === null ? "" : " · " + item.project) + " · " + age(item.createdAt),
      ),
      el("p", "", item.summary),
    );
    if (item.detail) main.append(el("pre", "detail", item.detail));
    if (stale) {
      main.append(el("p", "note", "Its Request ended, so there is nothing left to decide."));
    }
  }

  function renderTitle() {
    const n = view.count;
    document.title = n > 0 ? "(" + n + ") Kiln" : "Kiln";
    const badge = n > 0
      ? "<circle cx='22' cy='10' r='10' fill='#d93025'/><text x='22' y='14.5' font-size='13' " +
        "font-family='sans-serif' font-weight='bold' fill='#fff' text-anchor='middle'>" +
        (n > 9 ? "9+" : n) + "</text>"
      : "";
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>" +
      "<rect width='32' height='32' rx='6' fill='#1a1a1a'/>" + badge + "</svg>";
    favicon.href = "data:image/svg+xml," + encodeURIComponent(svg);
  }

  function render() {
    banner.style.display = view.running ? "none" : "block";
    renderTitle();
    renderRail();
    renderMain();
  }

  async function refresh() {
    try {
      const res = await fetch("/api/needs-you");
      if (res.status === 403) {
        problem = "This dashboard was restarted, open the new URL.";
      } else if (res.ok) {
        view = await res.json();
        problem = null;
      }
    } catch { /* the dashboard itself is unreachable; keep what is shown */ }
    render();
  }

  // Events are hints: a burst of them becomes one re-fetch of the snapshot.
  let timer;
  const refreshSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 250);
  };

  document.addEventListener("click", (event) => {
    const link = event.target.closest && event.target.closest("a[href^='/']");
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    go(link.getAttribute("href"));
  });
  addEventListener("popstate", render);
  setInterval(render, 30000); // ages move on

  const stream = new EventSource("/events"); // one stream for this tab
  stream.addEventListener("changed", refreshSoon);
  stream.addEventListener("open", refresh); // also after a reconnect
  render();
  refresh();
})();
