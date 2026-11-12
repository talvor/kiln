// The Dashboard's page script: the Needs you list, kept live by one Server-Sent Events stream.
// Everything an agent wrote reaches the page through textContent, never as markup.
"use strict";
(() => {
  const rail = document.getElementById("rail");
  const main = document.getElementById("main");
  const banner = document.getElementById("banner");
  const favicon = document.getElementById("favicon");
  let view = { running: true, count: 0, groups: [], stale: [], decided: [] };
  let problem = null;
  // What the user is doing to the selected Escalation: a refusal to show, a reason being typed,
  // a confirmation to offer. It survives live re-renders, and resets when another one is picked.
  const blankAct = {
    id: null,
    refusal: null,
    confirm: false,
    rejecting: false,
    reason: "",
    busy: false,
    confirmShownAt: null,
  };
  let act = { ...blankAct };

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
    if (path !== location.pathname) {
      act = { ...blankAct };
      history.pushState(null, "", path);
    }
    render(); // swap the main area: no page load
  }

  function when(iso) {
    const a = age(iso);
    return a === "just now" ? a : a + " ago";
  }

  async function settle(id, body) {
    if (act.busy) return;
    const currentAct = act;
    const stillHere = () => act === currentAct && act.id === id;
    act.busy = true;
    act.refusal = null;
    render();
    try {
      const res = await fetch("/api/escalations/" + id + "/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({ ok: false, error: "Something went wrong." }));
      // The user may have picked another Escalation meanwhile: the answer is not theirs to see.
      if (out.ok) {
        if (stillHere()) act = { ...blankAct, id };
      } else if (stillHere()) {
        act.busy = false;
        act.refusal = out.error;
        act.confirm = out.code === "needs-confirm";
        act.confirmShownAt = act.confirm ? Date.now() : null;
        if (res.status === 403) act.refusal = "This dashboard was restarted, open the new URL.";
      }
    } catch {
      if (stillHere()) {
        act.busy = false;
        act.refusal = "The dashboard could not be reached.";
      }
    }
    await refresh();
    render();
  }

  function actions(item) {
    const box = el("div", "actions");
    if (act.refusal) box.append(el("p", "refusal", act.refusal));
    const button = (label, onClick, className) => {
      const b = el("button", "btn" + (className ? " " + className : ""), label);
      b.type = "button";
      b.setAttribute("aria-disabled", String(act.busy));
      b.addEventListener("click", (event) => {
        if (!act.busy) onClick(event);
      });
      return b;
    };
    const bar = el("div", "bar");
    if (act.confirm) {
      bar.append(
        button("Approve anyway", (event) => {
          if (event.detail > 1 || Date.now() - act.confirmShownAt < 500) return;
          settle(item.id, { approved: true, confirm: true });
        }),
      );
    } else {
      bar.append(button("Approve", () => settle(item.id, { approved: true }), "approve"));
    }
    bar.append(button("Reject", () => {
      act.rejecting = !act.rejecting;
      render();
    }));
    box.append(bar);
    if (act.rejecting) {
      const form = el("form", "reject");
      const label = el("label", "", "Why reject it? (required)");
      const reason = el("textarea");
      reason.rows = 3;
      reason.value = act.reason;
      reason.addEventListener("input", () => {
        act.reason = reason.value;
        send.disabled = act.busy || !reason.value.trim();
      });
      label.append(reason);
      const send = el("button", "btn", "Reject with this reason");
      send.type = "submit";
      send.disabled = act.busy || !act.reason.trim();
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (act.reason.trim()) settle(item.id, { approved: false, reason: act.reason });
      });
      form.append(label, send);
      box.append(form);
    }
    return box;
  }

  function row(item, isStale) {
    const selected = selectedId() === item.id;
    const node = el("button", "row" + (selected ? " selected" : "") + (isStale ? " stale" : ""));
    node.type = "button";
    node.dataset.escalationId = String(item.id);
    const request = item.requestId === null ? "no Request" : "Request " + item.requestId;
    const kind = item.gate ?? "No gate";
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
    const scrolled = rail.scrollTop; // a live update must not throw the reader back to the top
    const decidedOpen = rail.querySelector("details")?.open ?? false;
    const previousRows = [...rail.querySelectorAll("button.row")];
    const focusedIndex = previousRows.indexOf(document.activeElement);
    const focusedId = previousRows[focusedIndex]?.dataset.escalationId;
    const previousSummary = rail.querySelector("summary");
    const focusedSummary = previousSummary !== null && previousSummary === document.activeElement;
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
    const decided = el("details");
    decided.open = decidedOpen;
    decided.append(el("summary", "", "Recently decided"));
    if (!(view.decided ?? []).length) decided.append(el("p", "empty", "Nothing decided yet."));
    for (const d of view.decided ?? []) {
      const node = el("div", "decided");
      node.append(
        el(
          "div",
          "meta",
          (d.decision === "approved" ? "Approved" : "Rejected") + " · " + when(d.decidedAt) +
            " · Source " + (d.source ?? "unknown"),
        ),
        el("div", "summary", d.summary),
      );
      if (d.reason) node.append(el("div", "reason", "Reason: " + d.reason));
      decided.append(node);
    }
    rail.append(decided);
    rail.scrollTop = scrolled;
    if (focusedSummary) rail.querySelector("summary").focus({ preventScroll: true });
    if (focusedId) {
      const rows = [...rail.querySelectorAll("button.row")];
      const target = rows.find((button) => button.dataset.escalationId === focusedId) ??
        rows[Math.min(focusedIndex, rows.length - 1)];
      if (target) target.focus({ preventScroll: true });
      else return true;
    }
    return false;
  }

  function renderMain() {
    main.replaceChildren();
    if (problem) return main.append(el("p", "note", problem));
    const id = selectedId();
    if (id === null) return main.append(el("p", "note", "Pick an Escalation to see its detail."));
    const all = [...view.groups.flatMap((g) => g.items), ...view.stale];
    const item = all.find((i) => i.id === id);
    if (!item) {
      main.append(el("p", "note", "Escalation " + id + " is not waiting on you."));
      if (act.id === id && act.refusal) main.append(el("p", "refusal", act.refusal));
      return;
    }
    const stale = view.stale.includes(item);
    main.append(
      el("h2", "", "Escalation " + item.id + (stale ? " (stale)" : "")),
      el(
        "p",
        "meta",
        (item.gate ?? "No gate") + " · " +
          (item.requestId === null ? "no Request" : "Request " + item.requestId) +
          (item.project === null ? "" : " · " + item.project) + " · " + age(item.createdAt),
      ),
      el("p", "", item.summary),
    );
    if (item.detail) main.append(el("pre", "detail", item.detail));
    if (stale) {
      main.append(el("p", "note", "Its Request ended, so there is nothing left to decide."));
      if (act.id === id && act.refusal) main.append(el("p", "refusal", act.refusal));
    } else {
      if (act.id !== item.id) {
        act = { ...blankAct, id: item.id };
      }
      main.append(actions(item));
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
    const mainFocused = main.contains(document.activeElement);
    const mainButtons = [...main.querySelectorAll("button")];
    const focusedButton = mainButtons.indexOf(document.activeElement);
    const reason = main.querySelector("textarea");
    const typing = reason !== null && reason === document.activeElement;
    const selection = typing
      ? [reason.selectionStart, reason.selectionEnd, reason.selectionDirection]
      : null;
    banner.style.display = view.running ? "none" : "block";
    renderTitle();
    const focusMain = renderRail();
    renderMain();
    if (typing) {
      const nextReason = main.querySelector("textarea");
      if (nextReason) {
        nextReason.focus({ preventScroll: true });
        nextReason.setSelectionRange(...selection);
        return;
      }
    }
    const nextButton = [...main.querySelectorAll("button")][focusedButton];
    const approvalChanged = mainButtons[focusedButton]?.textContent === "Approve" &&
      nextButton?.textContent === "Approve anyway";
    if (focusedButton >= 0 && nextButton && !approvalChanged) {
      nextButton.focus({ preventScroll: true });
      return;
    }
    if (focusMain || mainFocused) {
      const target = main.firstElementChild;
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  }

  let latestRefresh = 0;
  let latestApplied = 0;
  async function refresh() {
    const request = ++latestRefresh;
    try {
      const res = await fetch("/api/needs-you");
      if (res.status !== 403 && !res.ok) return;
      const next = res.ok ? await res.json() : null;
      if (request < latestApplied) return;
      latestApplied = request;
      if (res.status === 403) {
        problem = "This dashboard was restarted, open the new URL.";
      } else {
        view = next;
        problem = null;
      }
      render();
    } catch { /* the dashboard itself is unreachable; keep what is shown */ }
  }

  // Events are hints: a burst of them becomes one re-fetch of the snapshot.
  let timer;
  const refreshSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 250);
  };

  addEventListener("popstate", () => {
    if (act.id !== selectedId()) act = { ...blankAct };
    render();
  });
  setInterval(render, 30000); // ages move on

  const stream = new EventSource("/events"); // one stream for this tab
  stream.addEventListener("changed", refreshSoon);
  stream.addEventListener("open", refresh); // the first load, and after a reconnect
  stream.addEventListener("error", refreshSoon);
  render();
})();
