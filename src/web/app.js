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
  // The Transcript tab's Messages, and which long ones the user opened.
  let transcript = { id: null, messages: null, error: null };
  const opened = new Set();
  // The Report tab's summary of how the Request went.
  let report = { id: null, data: null, error: null };
  // The Cost view's report of today's spend.
  let cost = { data: null, error: null };
  // The Health view: the daemon's facts, and the doctor's checks while the user has run them.
  const health = { data: null, error: null, checks: null, checking: false, checkError: null };
  const CUT = 600;
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
    const match = /^\/requests\/(\d+)(\/(overview|transcript|report))?$/.exec(location.pathname);
    return match ? Number(match[1]) : null;
  };
  const liveRequest = (r) => r.status === "planned" || r.status === "active";
  /** The tab shown: the one in the address, else Overview while live and Report once finished. */
  const tabOf = (id) => {
    const named = /^\/requests\/\d+\/(overview|transcript|report)$/.exec(location.pathname);
    if (named) return named[1];
    const r = detail.id === id ? detail.data?.request : undefined;
    return r && !liveRequest(r) ? "report" : "overview";
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

  let healthSeq = 0;
  async function loadHealth() {
    const mine = ++healthSeq;
    const current = () => mine === healthSeq && location.pathname === "/health";
    try {
      const res = await fetch("/api/health");
      const out = await res.json().catch(() => ({ error: "Something went wrong." }));
      if (!current()) return;
      health.data = res.ok ? out : null;
      health.error = res.ok ? null : out.error ?? "Something went wrong.";
    } catch {
      if (!current()) return;
      health.error = "The dashboard could not be reached.";
    }
    render();
  }

  async function runChecks() {
    if (health.checking) return;
    health.checking = true;
    health.checkError = null;
    render();
    try {
      const res = await fetch("/api/doctor", { method: "POST" });
      const out = await res.json().catch(() => ({ ok: false, error: "Something went wrong." }));
      if (out.ok) health.checks = out.checks;
      else health.checkError = out.error ?? "Something went wrong.";
    } catch {
      health.checkError = "The dashboard could not be reached.";
    }
    health.checking = false;
    render();
  }

  let detailSeq = 0;
  async function loadDetail() {
    const mine = ++detailSeq;
    if (location.pathname === "/health") return loadHealth();
    const id = selectedRequestId();
    if (id === null) return location.pathname === "/cost" ? await loadCost(mine) : undefined;
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
    const tab = tabOf(id);
    if (tab === "transcript") await loadTranscript(id, current);
    else if (tab === "report") await loadReport(id, current);
  }

  async function loadCost(mine) {
    const current = () => mine === detailSeq && location.pathname === "/cost";
    try {
      const res = await fetch("/api/cost");
      const out = await res.json().catch(() => ({ error: "Something went wrong." }));
      if (!current()) return;
      if (res.ok) cost = { data: out.cost, error: null };
      else cost = { data: null, error: out.error ?? "Something went wrong." };
    } catch {
      if (!current()) return;
      cost = { data: cost.data, error: "The dashboard could not be reached." };
    }
    render();
  }

  async function loadReport(id, current) {
    try {
      const res = await fetch("/api/requests/" + id + "/report");
      const out = await res.json().catch(() => ({ error: "Something went wrong." }));
      if (!current()) return;
      if (res.ok) report = { id, data: out.report, error: null };
      else report = { id, data: null, error: out.error ?? "Something went wrong." };
    } catch {
      if (!current()) return;
      report = {
        id,
        data: report.id === id ? report.data : null,
        error: "The dashboard could not be reached.",
      };
    }
    render();
  }

  async function loadTranscript(id, current) {
    try {
      const res = await fetch("/api/requests/" + id + "/transcript");
      const out = await res.json().catch(() => ({ error: "Something went wrong." }));
      if (!current()) return;
      if (res.ok) {
        transcript = { id, messages: out.messages, error: null };
      } else {
        transcript = { id, messages: null, error: out.error ?? "Something went wrong." };
      }
    } catch {
      if (!current()) return;
      transcript = {
        id,
        messages: transcript.id === id ? transcript.messages : null,
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

  /** A Message's body as plain text: one `key: value` line per field. */
  function messageText(body) {
    return Object.entries(body ?? {}).map(([key, value]) =>
      key + ": " + (typeof value === "string" ? value : JSON.stringify(value))
    ).join("\n");
  }

  function messageItem(requestId, m) {
    const item = el("li", "msg");
    const head = el("div", "meta", clock(m.at) + " · " + m.from + " → " + m.to + " · " + m.kind);
    if (m.synthesised) head.append(el("span", "badge", "written by Kiln"));
    if (m.deadLettered) head.append(el("span", "badge", "dead-lettered"));
    item.append(head);
    const text = messageText(m.body);
    const key = requestId + ":" + m.id;
    const long = text.length > CUT;
    const open = opened.has(key);
    item.append(el("pre", "detail", long && !open ? text.slice(0, CUT) + "…" : text));
    if (long) {
      const more = el("button", "btn", open ? "Show less" : "Show more");
      more.type = "button";
      more.dataset.focusKey = key;
      more.addEventListener("click", () => {
        if (opened.has(key)) opened.delete(key);
        else opened.add(key);
        render();
      });
      item.append(more);
    }
    return item;
  }

  function renderTranscript(id) {
    if (transcript.id !== id || (transcript.messages === null && transcript.error === null)) {
      return main.append(el("p", "note", "Loading the transcript…"));
    }
    if (transcript.error) main.append(el("p", "refusal", transcript.error));
    if (transcript.messages === null) return;
    if (transcript.messages.length === 0) {
      return main.append(el("p", "empty", "No Messages were sent for this Request."));
    }
    const list = el("ul", "feed transcript");
    for (const m of transcript.messages) list.append(messageItem(id, m));
    main.append(list);
  }

  const span = (from, to) => {
    const ms = Date.parse(to) - Date.parse(from);
    if (!(ms >= 0)) return "";
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return Math.max(1, Math.round(ms / 1000)) + " s";
    if (minutes < 120) return minutes + " min";
    return Math.round(minutes / 6) / 10 + " h";
  };

  function renderReport(id) {
    if (report.id !== id || (report.data === null && report.error === null)) {
      return main.append(el("p", "note", "Loading the report…"));
    }
    if (report.error) main.append(el("p", "refusal", report.error));
    const r = report.data;
    if (r === null) return;
    const outcome = r.status === "done"
      ? "Finished"
      : r.status === "failed"
      ? "Failed"
      : r.status === "planned"
      ? "Waiting to start"
      : "Still running";
    main.append(el("h3", "", "Outcome"), el("p", "", outcome));
    if (r.failure) main.append(el("p", "refusal", "Failure: " + r.failure));
    for (const l of r.limitsReached) {
      main.append(
        el("p", "meta", "Assignment " + l.id + " was stopped at its " + l.limit + " limit."),
      );
    }
    main.append(el("h3", "", "Timings"));
    const timing = el("p", "meta");
    timing.textContent =
      (r.startedAt ? "Started " + new Date(r.startedAt).toLocaleString() : "Not started") +
      (r.endedAt
        ? " · Ended " + new Date(r.endedAt).toLocaleString() +
          (r.startedAt ? " · took " + span(r.startedAt, r.endedAt) : "")
        : "");
    main.append(timing, el("h3", "", "Cost"), budgetBar(r), el("h3", "", "Steps"));
    if (r.steps.length === 0) main.append(el("p", "empty", "No steps yet."));
    const steps = el("ol", "timeline");
    for (const s of r.steps) {
      const item = el("li", "step " + s.status);
      item.append(
        el(
          "div",
          "",
          s.position + ". " + s.name + " · " + s.status +
            (s.retries > 0 ? " · retried " + s.retries + "×" : ""),
        ),
      );
      if (s.summary) item.append(el("pre", "detail", s.summary));
      if (s.failure) item.append(el("div", "refusal", s.failure));
      steps.append(item);
    }
    if (r.steps.length > 0) main.append(steps);
    main.append(el("h3", "", "Escalations"));
    if (r.escalations.length === 0) main.append(el("p", "empty", "None were raised."));
    const list = el("ul", "feed");
    for (const e of r.escalations) {
      list.append(
        el(
          "li",
          "",
          "Escalation " + e.id + " · " + e.status + " · " + e.summary +
            (e.reason ? " · Reason: " + e.reason : "") + " · Source " + (e.via ?? "unknown"),
        ),
      );
    }
    if (r.escalations.length > 0) main.append(list);
    main.append(el("h3", "", "Branch, tickets and pull request"));
    const links = el("ul", "feed");
    const add = (label, value) => {
      const item = el("li", "", label + ": ");
      if (/^https?:\/\//.test(value)) {
        const a = el("a", "", value);
        a.href = value;
        a.rel = "noopener noreferrer";
        a.target = "_blank";
        item.append(a);
      } else item.append(el("span", "", value));
      links.append(item);
    };
    if (r.branch) add("Branch", r.branch);
    for (const url of [...new Set([r.ticketUrl, ...r.ticketUrls].filter(Boolean))]) {
      add("Ticket", url);
    }
    if (r.prUrl) add("Pull request", r.prUrl);
    if (links.children.length === 0) {
      main.append(el("p", "empty", "No branch, ticket or pull request yet."));
    } else main.append(links);
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
    const live = liveRequest(r);
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
    const shown = tabOf(id);
    for (
      const [label, path] of [
        ["Overview", "/requests/" + id + (live ? "" : "/overview")],
        ["Transcript", "/requests/" + id + "/transcript"],
        ["Report", "/requests/" + id + "/report"],
      ]
    ) {
      const tab = el("a", "tab" + (label.toLowerCase() === shown ? " active" : ""), label);
      tab.href = path;
      tab.addEventListener("click", (event) => {
        event.preventDefault();
        go(path);
      });
      tabs.append(tab);
    }
    main.append(tabs);
    if (r.failure) main.append(el("p", "refusal", "Failed: " + r.failure));
    if (shown === "transcript" || shown === "report") {
      if (shown === "transcript") renderTranscript(id);
      else renderReport(id);
      if (live) main.append(cancelControls(r));
      return;
    }
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

  function costTable(head, rows) {
    const table = el("table", "cost");
    const top = el("tr");
    for (const h of head) top.append(el("th", "", h));
    table.append(top);
    for (const row of rows) {
      const tr = el("tr");
      for (const cell of row) tr.append(el("td", "", cell));
      table.append(tr);
    }
    return table;
  }

  /** The Cost view: today against the daily cap, per Project and per Request, and unclaimed spend. */
  function renderCost() {
    main.append(el("h2", "", "Cost"));
    if (cost.error) main.append(el("p", "refusal", cost.error));
    const c = cost.data;
    if (!c) {
      if (!cost.error) main.append(el("p", "note", "Loading the cost…"));
      return;
    }
    main.append(
      el(
        "p",
        "meta",
        c.capUsd === null
          ? "Today (" + c.day + "): " + usd(c.todayUsd) + " spent, no daily cap set"
          : "Today (" + c.day + "): " + usd(c.todayUsd) + " of the " + usd(c.capUsd) +
            " daily cap" + (c.capReached ? " (cap reached)" : ""),
      ),
    );
    main.append(el("h3", "", "By Project (today)"));
    main.append(
      c.projects.length === 0
        ? el("p", "note", "No Project has spent anything today.")
        : costTable(["Project", "Today"], c.projects.map((p) => [p.name, usd(p.usd)])),
    );
    main.append(el("h3", "", "By Request"));
    main.append(
      c.requests.length === 0 ? el("p", "note", "No Request has spent anything today.") : costTable(
        ["Request", "Project", "Today", "Total", "Budget"],
        c.requests.map((r) => [
          "#" + r.id,
          r.project,
          usd(r.usd),
          usd(r.totalUsd),
          r.budgetUsd === null
            ? "no Budget set"
            : usd(r.totalUsd) + " of " + usd(r.budgetUsd) + " (" +
              Math.round(r.budgetUsd > 0 ? (r.totalUsd / r.budgetUsd) * 100 : 100) + "%)",
        ]),
      ),
    );
    main.append(el("h3", "", "Unclaimed spend"));
    main.append(
      el(
        "p",
        "meta",
        usd(c.otherUsd) + " today that no Request claims, such as the Overseer's own.",
      ),
    );
  }

  function uptime(iso) {
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (seconds < 60) return seconds + " s";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + " min";
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return hours + " h " + (minutes % 60) + " min";
    return Math.floor(hours / 24) + " d " + (hours % 24) + " h";
  }

  function healthSection(title, items, empty) {
    const box = el("section", "health-section");
    box.append(el("h3", "", title));
    if (items.length === 0) box.append(el("p", "meta", empty));
    else {
      const list = el("ul", "health-list");
      for (const text of items) list.append(el("li", "", text));
      box.append(list);
    }
    return box;
  }

  function renderHealth() {
    main.append(el("h2", "", "Health"));
    const h = health.data;
    if (!view.running || (h && !h.running)) {
      main.append(el("p", "note", "Kiln is not running."));
    } else if (!h) {
      main.append(el("p", "note", health.error ?? "Loading…"));
    } else {
      if (health.error) main.append(el("p", "refusal", health.error));
      main.append(
        el(
          "p",
          "",
          "Kiln " + h.version + " · pid " + h.pid + " · up " + uptime(h.startedAt),
        ),
        el(
          "p",
          "meta",
          h.haltedSince === null ? "Running" : "Halted " + when(h.haltedSince),
        ),
      );
      const bar = el("div", "bar");
      const control = (label, path) => {
        const b = el("button", "btn", label);
        b.type = "button";
        b.setAttribute("aria-disabled", String(stripBusy));
        b.addEventListener("click", (event) => {
          if (event.detail > 1) return;
          haltOrResume(path);
        });
        bar.append(b);
      };
      if (h.haltedSince === null) control("Halt", "/api/halt");
      if (h.haltedSince !== null || h.stuck.length > 0) control("Resume", "/api/resume");
      main.append(bar);
      if (stripRefusal) main.append(el("p", "refusal", stripRefusal.message));
      main.append(
        healthSection(
          "Stuck agents",
          h.stuck.map((s) =>
            s.address + (s.requestId === null ? "" : " · Request " + s.requestId) +
            " · stuck " + when(s.since)
          ),
          "None.",
        ),
        healthSection(
          "Faults",
          h.faults.map((f) =>
            f.project + " · " + f.kind + " · " + f.detail + " · " + when(f.since)
          ),
          "None.",
        ),
        healthSection("Paused Projects", h.paused, "None."),
      );
    }
    const checks = el("section", "health-section");
    checks.append(el("h3", "", "Checks"));
    const run = el("button", "btn", health.checking ? "Running checks…" : "Run checks");
    run.type = "button";
    run.setAttribute("aria-disabled", String(health.checking));
    run.addEventListener("click", (event) => {
      if (event.detail > 1) return;
      runChecks();
    });
    checks.append(run);
    if (health.checkError) checks.append(el("p", "refusal", health.checkError));
    if (health.checks) {
      const list = el("ul", "health-list");
      for (const c of health.checks) {
        list.append(el("li", "check-" + c.status, c.status + " · " + c.name + " · " + c.detail));
      }
      checks.append(list);
    }
    main.append(checks);
  }

  function renderMain() {
    main.replaceChildren();
    if (location.pathname === "/health") return renderHealth();
    const requestId = selectedRequestId();
    if (requestId !== null) return renderRequest(requestId);
    const id = selectedId();
    if (location.pathname === "/cost") {
      return renderCost();
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
    render();
    try {
      const res = await fetch(path, { method: "POST" });
      const out = await res.json().catch(() => ({ ok: false, error: "Something went wrong." }));
      if (!out.ok) stripRefusal = { message: out.error, transient: out.code === "down" };
    } catch {
      stripRefusal = { message: "The dashboard could not be reached.", transient: true };
    }
    await refresh();
    stripBusy = false;
    render();
  }

  function renderStrip() {
    const focusedLink = [...stripBox.querySelectorAll("a")].find((a) =>
      a === document.activeElement
    );
    const focusedLabel = !focusedLink && stripBox.contains(document.activeElement)
      ? document.activeElement.textContent
      : null;
    stripBox.replaceChildren();
    const strip = view.strip;
    if (!view.running || !strip) return;
    // Each condition opens the Health view.
    const condition = (key, text) => {
      const a = el("a", "cond", text);
      a.dataset.key = key;
      a.href = "/health";
      a.addEventListener("click", (event) => {
        event.preventDefault();
        go("/health");
      });
      stripBox.append(a);
    };
    if (strip.haltedSince !== null) condition("halted", "Halted " + when(strip.haltedSince));
    if (strip.capReached) condition("cap", "Daily cap reached");
    if (strip.stuck > 0) {
      condition("stuck", strip.stuck + " Stuck agent" + (strip.stuck === 1 ? "" : "s"));
    }
    const cost = el(
      "a",
      "",
      strip.capUsd === null
        ? usd(strip.todayUsd) + " today"
        : usd(strip.todayUsd) + " of " + usd(strip.capUsd) + " today",
    );
    cost.dataset.key = "cost";
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
    if (focusedLink) {
      const same = [...stripBox.querySelectorAll("a")].find((a) =>
        a.dataset.key === focusedLink.dataset.key
      ) ?? cost;
      same.focus({ preventScroll: true });
    } else if (focusedLabel) {
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
    const focusedButton = [...main.querySelectorAll("button")].find((button) =>
      button === document.activeElement
    );
    const focusedLink = [...main.querySelectorAll("a")].find((link) =>
      link === document.activeElement
    );
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
    const nextLink = focusedLink &&
      [...main.querySelectorAll("a")].find((link) => link.href === focusedLink.href);
    if (nextLink) {
      nextLink.focus({ preventScroll: true });
      return;
    }
    const buttons = [...main.querySelectorAll("button")];
    const nextButton = focusedButton &&
      buttons.find((button) =>
        focusedButton.dataset.focusKey
          ? button.dataset.focusKey === focusedButton.dataset.focusKey
          : !button.dataset.focusKey && button.textContent === focusedButton.textContent
      );
    if (nextButton) {
      nextButton.focus({ preventScroll: true });
      return;
    }
    if (focusedButton?.textContent === "Cancel Request") {
      const safeChoice = buttons.find((button) => button.textContent === "Keep it running");
      if (safeChoice) {
        safeChoice.focus({ preventScroll: true });
        return;
      }
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
