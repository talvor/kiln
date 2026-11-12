// The Dashboard's page script: the Needs you list, kept live by one Server-Sent Events stream.
// Everything an agent wrote reaches the page through textContent, never as markup.
"use strict";
(() => {
  const rail = document.getElementById("rail");
  const main = document.getElementById("main");
  const banner = document.getElementById("banner");
  const favicon = document.getElementById("favicon");
  const stripBox = document.getElementById("strip");
  let stripBusy = false; // Halt or Resume is in flight: one at a time
  let stripRefusal = null;
  let view = { running: true, count: 0, groups: [], stale: [], decided: [], requests: [] };
  let showFinished = false; // the rail's "Show finished" toggle
  // The selected Request's Overview, fetched on its own. `cancelling` is the Cancel confirm step.
  let detail = { id: null, data: null, error: null };
  const requestDetails = new Map();
  const blankCancel = { asking: false, busy: false, refusal: null, shownAt: null };
  let cancelAct = { ...blankCancel };
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

  const selectedRequestId = () => {
    const match = /^\/requests\/(\d+)$/.exec(location.pathname);
    return match ? Number(match[1]) : null;
  };

  function go(path) {
    if (path !== location.pathname) {
      act = { ...blankAct };
      cancelAct = { ...blankCancel };
      history.pushState(null, "", path);
    }
    render(); // swap the main area: no page load
    loadDetail();
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
          if (repeated(event, act.confirmShownAt)) return;
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

  const stateLabel = (r, waiting) => {
    if (waiting && (r.status === "planned" || r.status === "active")) return "waiting on you";
    return r.status === "planned" ? "waiting" : r.status;
  };

  // A double click, a held key, or a click right after the step appeared repeats the gesture that
  // opened a confirm step: it cannot confirm.
  const repeated = (event, shownAt) => event.detail > 1 || Date.now() - shownAt < 500;

  function requestRow(r) {
    const selected = selectedRequestId() === r.id;
    const node = el("button", "row request" + (selected ? " selected" : ""));
    node.type = "button";
    node.dataset.requestId = String(r.id);
    const state = stateLabel(r, r.waiting);
    node.append(
      el("div", "meta", "Request " + r.id + " · " + r.project + " · " + state),
      el("div", "summary", r.description ?? r.playbook ?? "No description"),
    );
    node.addEventListener("click", () => go("/requests/" + r.id));
    return node;
  }

  function renderRequestsRail() {
    rail.append(el("h2", "", "Requests"));
    const toggle = el("button", "btn toggle", showFinished ? "Hide finished" : "Show finished");
    toggle.type = "button";
    toggle.setAttribute("aria-pressed", String(showFinished));
    toggle.addEventListener("click", () => {
      showFinished = !showFinished;
      render();
    });
    rail.append(toggle);
    const shown = (view.requests ?? []).filter((r) => showFinished || r.recent);
    if (shown.length === 0) rail.append(el("p", "empty", "No Requests are running."));
    for (const r of shown) rail.append(requestRow(r));
  }

  function renderRail() {
    const scrolled = rail.scrollTop; // a live update must not throw the reader back to the top
    const decidedOpen = rail.querySelector("details")?.open ?? false;
    const previousRows = [...rail.querySelectorAll("button.row")];
    const focusedIndex = previousRows.indexOf(document.activeElement);
    const rowKey = (button) =>
      button?.dataset.escalationId !== undefined
        ? "e" + button.dataset.escalationId
        : button?.dataset.requestId !== undefined
        ? "r" + button.dataset.requestId
        : undefined;
    const focusedId = rowKey(previousRows[focusedIndex]);
    const toggleFocused = document.activeElement !== null &&
      rail.contains(document.activeElement) && document.activeElement.className.includes("toggle");
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
    renderRequestsRail();
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
    if (toggleFocused) rail.querySelector("button.toggle")?.focus({ preventScroll: true });
    if (focusedId) {
      const rows = [...rail.querySelectorAll("button.row")];
      const target = rows.find((button) => rowKey(button) === focusedId) ??
        rows[Math.min(focusedIndex, rows.length - 1)];
      if (target) target.focus({ preventScroll: true });
      else return true;
    }
    return false;
  }

  let detailSeq = 0;
  async function loadDetail() {
    const mine = ++detailSeq;
    const id = selectedRequestId();
    if (id === null) return;
    const current = () => mine === detailSeq && selectedRequestId() === id;
    const cached = requestDetails.get(id);
    const after = cached?.last ?? 0;
    try {
      const res = await fetch("/api/requests/" + id + (after ? "?after=" + after : ""));
      const out = await res.json().catch(() => ({ error: "Something went wrong." }));
      if (!current()) return;
      if (res.ok) {
        const data = { ...out, events: [...(cached?.events ?? []), ...out.events] };
        requestDetails.set(id, data);
        detail = { id, data, error: null };
      } else {
        detail = { id, data: null, error: out.error ?? "Something went wrong." };
      }
    } catch {
      if (!current()) return;
      detail = {
        id,
        data: detail.id === id ? detail.data : null,
        error: "The dashboard could not be reached.",
      };
    }
    render();
  }

  async function cancelRequest(id) {
    if (cancelAct.busy) return;
    const mine = cancelAct;
    mine.busy = true;
    mine.refusal = null;
    render();
    try {
      const res = await fetch("/api/requests/" + id + "/cancel", { method: "POST" });
      const out = await res.json().catch(() => ({ ok: false, error: "Something went wrong." }));
      if (out.ok) {
        if (cancelAct === mine) cancelAct = { ...blankCancel };
      } else if (cancelAct === mine) {
        mine.busy = false;
        mine.asking = false;
        mine.refusal = out.error;
      }
    } catch {
      if (cancelAct === mine) {
        mine.busy = false;
        mine.refusal = "The dashboard could not be reached.";
      }
    }
    await refresh();
    render();
  }

  function cancelControls(r) {
    const box = el("div", "actions");
    if (cancelAct.refusal) box.append(el("p", "refusal", cancelAct.refusal));
    const button = (label, onClick, className) => {
      const b = el("button", "btn" + (className ? " " + className : ""), label);
      b.type = "button";
      b.setAttribute("aria-disabled", String(cancelAct.busy));
      b.addEventListener("click", (event) => {
        if (!cancelAct.busy) onClick(event);
      });
      return b;
    };
    if (!cancelAct.asking) {
      box.append(button("Cancel Request", () => {
        cancelAct.asking = true;
        cancelAct.shownAt = Date.now();
        render();
      }));
      return box;
    }
    box.append(
      el(
        "p",
        "",
        "Cancel Request " + r.id + "? Its workers stop and it fails. Its branches, Worktrees " +
          "and anything pushed stay.",
      ),
    );
    const bar = el("div", "bar");
    // The safe choice comes first, so focus that survives the re-render lands on it.
    bar.append(
      button("Keep it running", () => {
        cancelAct = { ...blankCancel };
        render();
      }),
      button("Yes, cancel it", (event) => {
        if (repeated(event, cancelAct.shownAt)) return;
        cancelRequest(r.id);
      }, "danger"),
    );
    box.append(bar);
    return box;
  }

  const clock = (iso) => new Date(iso).toLocaleTimeString();

  function budgetBar(r) {
    const box = el("div", "budget");
    if (r.budgetUsd === null) {
      box.append(el("p", "meta", "Budget: " + usd(r.costUsd) + " spent, no Budget set"));
      return box;
    }
    const share = r.budgetUsd > 0 ? r.costUsd / r.budgetUsd : 1;
    box.append(
      el(
        "p",
        "meta",
        "Budget: " + usd(r.costUsd) + " of " + usd(r.budgetUsd) + " (" + Math.round(share * 100) +
          "%)",
      ),
    );
    const track = el("div", "track");
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(r.budgetUsd));
    track.setAttribute("aria-valuenow", String(r.costUsd));
    const fill = el("div", "fill" + (share >= 1 ? " over" : ""));
    fill.style.width = Math.min(100, share * 100) + "%";
    track.append(fill);
    box.append(track);
    return box;
  }

  function timeline(r) {
    const list = el("ol", "timeline");
    for (const step of r.steps) {
      const item = el("li", "step " + step.status);
      item.append(
        el(
          "div",
          "",
          step.position + ". " + step.name + " · " + step.department + " · " + step.status +
            (step.retries > 0 ? " · retried " + step.retries + "×" : ""),
        ),
      );
      if (step.failure) item.append(el("div", "refusal", step.failure));
      for (const a of step.assignments) {
        item.append(
          el(
            "div",
            "meta assignment",
            "Assignment " + a.id + " · " + a.worker + " · " + a.status + " · " + a.turnsUsed +
              " turns · " + usd(a.spendUsd) + (a.limitReached ? " · limit: " + a.limitReached : ""),
          ),
        );
      }
      list.append(item);
    }
    return list;
  }

  function renderRequest(id) {
    const row = (view.requests ?? []).find((r) => r.id === id);
    if (detail.id !== id || (detail.data === null && detail.error === null)) {
      return main.append(el("p", "note", "Loading Request " + id + "…"));
    }
    if (detail.data === null) {
      return main.append(el("p", "note", "Request " + id + ": " + detail.error));
    }
    const r = detail.data.request;
    const live = r.status === "planned" || r.status === "active";
    const waiting = row?.waiting === true;
    main.append(
      el("h2", "", "Request " + r.id),
      el(
        "p",
        "meta",
        r.project + " · " +
          stateLabel(r, waiting) +
          (r.playbook ? " · " + r.playbook : ""),
      ),
    );
    if (r.description) main.append(el("p", "", r.description));
    const tabs = el("div", "tabs");
    tabs.append(el("span", "tab active", "Overview"));
    main.append(tabs);
    if (r.failure) main.append(el("p", "refusal", "Failed: " + r.failure));
    main.append(budgetBar(r), el("h3", "", "Steps"));
    if (r.steps.length === 0) main.append(el("p", "empty", "No steps yet."));
    else main.append(timeline(r));
    main.append(el("h3", "", "Live feed"));
    const feed = el("ul", "feed");
    const events = detail.data.events;
    if (events.length === 0) feed.append(el("li", "empty", "Nothing has happened yet."));
    for (const e of events.toReversed()) {
      feed.append(el("li", "", clock(e.ts) + " · " + e.text));
    }
    main.append(feed);
    if (live) main.append(cancelControls(r));
  }

  function renderMain() {
    main.replaceChildren();
    const requestId = selectedRequestId();
    if (requestId !== null) return renderRequest(requestId);
    const id = selectedId();
    if (location.pathname === "/cost") {
      return main.append(el("p", "note", "The Cost view is not built yet."));
    }
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

  const usd = (n) => "$" + n.toFixed(2);

  async function haltOrResume(path) {
    if (stripBusy) return;
    stripBusy = true;
    stripRefusal = null;
    renderStrip();
    try {
      const res = await fetch(path, { method: "POST" });
      const out = await res.json().catch(() => ({ ok: false, error: "Something went wrong." }));
      if (!out.ok) stripRefusal = { message: out.error, transient: out.code === "down" };
    } catch {
      stripRefusal = { message: "The dashboard could not be reached.", transient: true };
    }
    await refresh();
    stripBusy = false;
    renderStrip();
  }

  function renderStrip() {
    const focusedLink = document.activeElement !== null &&
      stripBox.querySelector("a") === document.activeElement;
    const focusedLabel = !focusedLink && stripBox.contains(document.activeElement)
      ? document.activeElement.textContent
      : null;
    stripBox.replaceChildren();
    const strip = view.strip;
    if (!view.running || !strip) return;
    if (strip.haltedSince !== null) {
      stripBox.append(el("span", "cond", "Halted " + when(strip.haltedSince)));
    }
    if (strip.capReached) stripBox.append(el("span", "cond", "Daily cap reached"));
    if (strip.stuck > 0) {
      stripBox.append(
        el("span", "cond", strip.stuck + " Stuck agent" + (strip.stuck === 1 ? "" : "s")),
      );
    }
    const cost = el(
      "a",
      "",
      strip.capUsd === null
        ? usd(strip.todayUsd) + " today"
        : usd(strip.todayUsd) + " of " + usd(strip.capUsd) + " today",
    );
    cost.href = "/cost";
    cost.addEventListener("click", (event) => {
      event.preventDefault();
      go("/cost");
    });
    stripBox.append(cost);
    if (stripRefusal) stripBox.append(el("span", "cond", stripRefusal.message));
    const button = (label, path) => {
      const b = el("button", "btn", label);
      b.type = "button";
      b.setAttribute("aria-disabled", String(stripBusy));
      // A held key or a double click repeats the click: only the first one counts.
      b.addEventListener("click", (event) => {
        if (event.detail > 1) return;
        haltOrResume(path);
      });
      return b;
    };
    if (strip.haltedSince === null) stripBox.append(button("Halt", "/api/halt"));
    if (strip.haltedSince !== null || strip.stuck > 0) {
      stripBox.append(button("Resume", "/api/resume"));
    }
    if (focusedLink) cost.focus({ preventScroll: true });
    else if (focusedLabel) {
      const same = [...stripBox.querySelectorAll("button")].find((b) =>
        b.textContent === focusedLabel
      );
      if (same) same.focus({ preventScroll: true });
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
    if (problem) {
      banner.style.display = "none";
      renderTitle();
      rail.replaceChildren();
      stripBox.replaceChildren();
      main.replaceChildren(el("p", "note", problem));
      return;
    }
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
    renderStrip();
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
  let retryTimer = null;
  let failedRefreshes = 0;
  const retryDelays = [500, 1000, 2000];
  function failedRefresh(request) {
    if (request < latestRefresh || retryTimer !== null) return;
    if (failedRefreshes === retryDelays.length) {
      problem =
        "This dashboard was restarted or stopped. Open the new URL printed by kiln dashboard.";
      view = { running: true, count: 0, groups: [], stale: [], decided: [], requests: [] };
      stream.close();
      render();
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      refresh();
    }, retryDelays[failedRefreshes++]);
  }
  async function refresh() {
    if (problem || retryTimer !== null) return;
    const request = ++latestRefresh;
    try {
      const res = await fetch("/api/needs-you");
      if (res.status !== 403 && !res.ok) return;
      if (res.status === 403) return failedRefresh(request);
      const next = await res.json();
      if (request < latestApplied) return;
      latestApplied = request;
      clearTimeout(retryTimer);
      retryTimer = null;
      failedRefreshes = 0;
      if (next.running && stripRefusal?.transient) stripRefusal = null;
      view = next;
      render();
      await loadDetail();
    } catch {
      failedRefresh(request);
    }
  }

  // Events are hints: a burst of them becomes one re-fetch of the snapshot.
  let timer;
  const refreshSoon = () => {
    if (problem || retryTimer !== null) return;
    clearTimeout(timer);
    timer = setTimeout(refresh, 250);
  };

  addEventListener("popstate", () => {
    if (act.id !== selectedId()) act = { ...blankAct };
    cancelAct = { ...blankCancel };
    render();
    loadDetail();
  });
  setInterval(() => {
    render(); // ages move on
    refreshSoon();
  }, 30000);

  const stream = new EventSource("/events"); // one stream for this tab
  stream.addEventListener("changed", refreshSoon);
  stream.addEventListener("open", refresh); // the first load, and after a reconnect
  stream.addEventListener("error", refreshSoon);
  render();
})();
