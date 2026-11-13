// PROTOTYPE (throwaway): the "Board" view at /board?variant=A|B[&demo=1].
// Question: how should a Request's steps be laid out across the screen as columns, with the
// Request's summary box moving from column to column as it advances?
//   A  Kanban columns   — one column per step, cards stack in the column they are in (FLIP slide).
//   B  Swimlanes by playbook — expandable group per Playbook with its own step columns, one row per Request, columns are steps, one token slides along its row.
// Live data comes from /api/needs-you + /api/requests/<id>. With no live Requests (or ?demo=1) a
// simulator advances fake Requests every few seconds so the movement can be judged.
// Clicking a Request opens a dialog (Details / Transcript / Logs / Report).
// Not production: no tests, minimal error handling, shares nothing with app.js except #main.
"use strict";
(() => {
  const main = document.getElementById("main");
  const panes = document.getElementById("panes");
  const VARIANTS = { A: "Kanban columns", B: "Swimlanes by playbook" };
  const q = () => new URLSearchParams(location.search);
  const onBoard = () => location.pathname === "/board";
  const variant = () => (q().get("variant") in VARIANTS ? q().get("variant") : "A");
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // ---- data -------------------------------------------------------------------------------
  let requests = []; // normalised: {id,project,description,playbook,state,waiting,cost,budget,steps}
  let demo = false;

  async function loadLive() {
    const snap = await (await fetch("/api/needs-you")).json();
    const rows = (snap.requests ?? []).filter((r) => r.recent);
    const out = [];
    for (const row of rows) {
      const d = await (await fetch("/api/requests/" + row.id)).json().catch(() => null);
      const r = d?.request;
      if (!r) continue;
      out.push({
        id: r.id,
        project: r.project,
        description: r.description ?? r.playbook ?? "No description",
        playbook: r.playbook,
        state: r.status,
        waiting: row.waiting,
        cost: r.costUsd ?? 0,
        budget: r.budgetUsd ?? 0,
        steps: r.steps.map((s) => ({ name: s.name, status: s.status, department: s.department })),
      });
    }
    return out;
  }

  // Simulator: each tick, every unfinished Request advances (or stalls on you) with some luck.
  const PB = {
    "implement-a-ticket": ["wayfind", "implement", "review", "qa", "wrap-up"],
    "diagnose-a-bug": ["diagnose", "plan-fix-ticket"],
    "design-a-feature": ["write-spec", "design-seams"],
  };
  const SEED = [
    ["kiln", "Digest emails fire twice on Mondays", "implement-a-ticket"],
    ["shop", "Idempotency keys for the refund API", "implement-a-ticket"],
    ["shop", "Order search returns deleted SKUs", "diagnose-a-bug"],
    ["kiln", "Rate-limit login attempts by IP", "implement-a-ticket"],
    ["docs", "Offline mode for the reader app", "design-a-feature"],
  ];
  function seedDemo() {
    return SEED.map(([project, description, playbook], i) => ({
      id: 101 + i,
      project,
      description,
      playbook,
      state: "active",
      waiting: false,
      cost: Math.random() * 2,
      budget: 10,
      steps: PB[playbook].map((name) => ({ name, status: "planned", department: "engineering" })),
      _tick: i, // stagger
    }));
  }
  function tickDemo() {
    for (const r of requests) {
      if (r.state === "done" || r.state === "failed") continue;
      if (r._tick-- > 0) continue;
      r.cost += Math.random() * 0.6;
      if (r.waiting) {
        if (Math.random() < 0.5) r.waiting = false;
        continue;
      }
      const i = r.steps.findIndex((s) => s.status !== "done");
      if (i === -1) continue;
      const s = r.steps[i];
      if (s.status === "planned") s.status = "active";
      else if (Math.random() < 0.08) {
        s.status = "failed";
        r.state = "failed";
      } else if (Math.random() < 0.2 && i === 1) r.waiting = true;
      else {
        s.status = "done";
        if (i + 1 === r.steps.length) r.state = "done";
        else r.steps[i + 1].status = "active";
      }
      if (r.steps[0].status === "planned" && i === 0) r.steps[0].status = "active";
    }
    // a finished Request is replaced after a while so the demo keeps moving
    if (requests.every((r) => r.state === "done" || r.state === "failed")) {
      requests = seedDemo();
    }
  }

  // ---- columns ----------------------------------------------------------------------------
  const stepNames = () => {
    const seen = [];
    for (const r of requests) {
      r.steps.forEach((s, i) => {
        if (!seen.some((x) => x.name === s.name)) seen.push({ name: s.name, pos: i });
      });
    }
    return seen.sort((a, b) => a.pos - b.pos).map((x) => x.name);
  };
  /** The column a Request sits in, as a step name or "done"/"failed"/"queued". */
  const columnOf = (r) => {
    if (r.state === "done") return "done";
    if (r.state === "failed") return "failed";
    const s = r.steps.find((x) => x.status === "active" || x.status === "failed") ??
      r.steps.find((x) => x.status === "planned");
    return s ? s.name : "queued";
  };
  const progress = (r) =>
    r.steps.length === 0 ? 0 : r.steps.filter((s) => s.status === "done").length / r.steps.length;
  const usd = (n) => "$" + n.toFixed(2);

  // ---- shared card ------------------------------------------------------------------------
  const cards = new Map(); // id -> element, kept so a card can slide instead of being rebuilt
  function fillCard(card, r, compact) {
    card.replaceChildren();
    card.className = "pb-card" + (r.waiting ? " waiting" : "") +
      (r.state === "failed" ? " bad" : "") +
      (r.state === "done" ? " ok" : "");
    const head = el("div", "pb-head");
    head.append(el("span", "pb-id", "#" + r.id), el("span", "pb-proj", r.project));
    if (r.waiting) head.append(el("span", "pb-badge", "waiting on you"));
    card.append(head, el("div", "pb-title", r.description));
    if (!compact) {
      const track = el("div", "pb-track");
      const fill = el("div", "pb-fill");
      fill.style.width = Math.round(progress(r) * 100) + "%";
      track.append(fill);
      card.append(track);
      card.append(el("div", "pb-meta", usd(r.cost) + (r.budget ? " of " + usd(r.budget) : "")));
    }
  }
  function cardFor(r, compact) {
    let c = cards.get(r.id + (compact ? "c" : ""));
    if (!c) {
      c = el("div");
      c.tabIndex = 0;
      c.addEventListener("click", () => openDialog(r.id));
      c.addEventListener("keydown", (e) => e.key === "Enter" && openDialog(r.id));
      cards.set(r.id + (compact ? "c" : ""), c);
    }
    fillCard(c, r, compact);
    return c;
  }

  // ---- variant A: kanban ------------------------------------------------------------------
  function renderA(root) {
    const cols = ["queued", ...stepNames(), "done", "failed"];
    const before = new Map(
      [...cards].filter(([, c]) => c.isConnected).map(([k, c]) => [
        k,
        c.getBoundingClientRect(),
      ]),
    );
    const board = el("div", "pb-board");
    const bodies = new Map();
    for (const name of cols) {
      const col = el("section", "pb-col pb-col-" + name);
      const n = requests.filter((r) => columnOf(r) === name).length;
      const h = el("h3", "pb-colhead");
      h.append(el("span", "", name), el("span", "pb-count", String(n)));
      const body = el("div", "pb-colbody");
      col.append(h, body);
      board.append(col);
      bodies.set(name, body);
    }
    for (const r of requests) bodies.get(columnOf(r)).append(cardFor(r, false));
    root.replaceChildren(board);
    // FLIP: slide each card from where it was to where it is now
    for (const [k, c] of cards) {
      const was = before.get(k);
      if (!was || !c.isConnected) continue;
      const now = c.getBoundingClientRect();
      const dx = was.left - now.left, dy = was.top - now.top;
      if (!dx && !dy) continue;
      c.animate([{ transform: `translate(${dx}px,${dy}px)`, zIndex: 5 }, { transform: "none" }], {
        duration: 700,
        easing: "cubic-bezier(.2,.8,.2,1)",
      });
    }
  }

  // ---- variant B: swimlanes, grouped by playbook ---------------------------------------------
  const collapsed = new Set(); // playbook names the user folded; survives repaints
  function renderB(root) {
    const groups = new Map();
    for (const r of requests) {
      const k = r.playbook ?? "(no playbook)";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    // keep existing tokens' left so the CSS transition has something to slide from
    const prev = new Map();
    for (const [k, c] of cards) {
      if (c.isConnected && c.classList.contains("pb-token")) prev.set(k, c.style.left);
    }
    const all = el("div", "pb-groups");
    for (const [name, rs] of groups) {
      // this playbook's own columns, from the steps of its Requests
      const steps = [];
      for (const r of rs) {
        r.steps.forEach((st, i) => {
          if (!steps.includes(st.name)) steps.splice(i, 0, st.name);
        });
      }
      const cols = ["queued", ...steps, "done"];
      const open = !collapsed.has(name);
      const g = el("section", "pb-group" + (open ? " open" : ""));
      const waiting = rs.filter((r) => r.waiting).length;
      const running = rs.filter((r) => r.state !== "done" && r.state !== "failed").length;
      const head = el("button", "pb-grouphead");
      head.append(
        el("span", "pb-caret", open ? "▾" : "▸"),
        el("span", "pb-groupname", name),
        el("span", "pb-count", running + " running"),
      );
      if (waiting) head.append(el("span", "pb-badge", waiting + " waiting on you"));
      head.onclick = () => {
        collapsed.has(name) ? collapsed.delete(name) : collapsed.add(name);
        paint();
      };
      g.append(head);
      if (open) {
        const grid = el("div", "pb-lanes");
        grid.style.setProperty("--cols", cols.length);
        const lh = el("div", "pb-lane pb-lanehead");
        const cells = el("div", "pb-cells");
        for (const c of cols) cells.append(el("div", "pb-cellhead", c));
        lh.append(el("div", "pb-lanelabel"), cells);
        grid.append(lh);
        for (const r of rs) {
          const lane = el("div", "pb-lane");
          const label = el("div", "pb-lanelabel");
          label.append(
            el("div", "pb-id", "#" + r.id + " · " + r.project),
            el("div", "pb-meta", usd(r.cost)),
          );
          const lcells = el("div", "pb-cells");
          const cur = Math.max(0, cols.indexOf(columnOf(r)));
          cols.forEach((c, n) => {
            const cell = el("div", "pb-cell");
            if (n === 0) cell.classList.add("first");
            if (n === cols.length - 1) cell.classList.add("last");
            if (n < cur) cell.classList.add("passed"); // the line leaving this dot is travelled
            const st = r.steps.find((x) => x.name === c);
            const failed = st?.status === "failed" || (c === "done" && r.state === "failed");
            const ticked = n < cur || (c === "done" && r.state === "done");
            const dot = el(
              "div",
              "pb-dot" + (ticked ? " tick" : "") + (failed ? " fail" : ""),
              failed ? "✕" : ticked ? "✓" : "",
            );
            cell.append(dot);
            lcells.append(cell);
          });
          const token = cardFor(r, true);
          token.classList.add("pb-token");
          const idx = Math.max(0, cols.indexOf(columnOf(r)));
          token.style.left = `calc(${idx} * (100% / ${cols.length}) + 4px)`;
          token.style.width = `calc(100% / ${cols.length} - 8px)`;
          lcells.append(token);
          lane.append(label, lcells);
          grid.append(lane);
        }
        g.append(grid);
      }
      all.append(g);
    }
    root.replaceChildren(all);
    for (const [k, c] of cards) {
      const was = prev.get(k);
      if (was === undefined || !c.isConnected) continue;
      const now = c.style.left;
      c.style.left = was;
      c.getBoundingClientRect();
      c.style.left = now;
    }
  }

  // ---- request dialog: details + transcript / logs / report tabs -------------------------------
  const TABS = ["Details", "Transcript", "Logs", "Report"];
  let dlg = null, dlgId = null, dlgTab = "Details";
  const clock = (iso) => new Date(iso).toLocaleTimeString();
  const fake = (r) => {
    const now = Date.now();
    const t = (i) => new Date(now - (20 - i) * 60000).toISOString();
    const done = r.steps.filter((x) => x.status === "done");
    return {
      messages: [
        {
          id: 1,
          at: t(0),
          from: "user",
          to: "overseer",
          kind: "request",
          body: { description: r.description },
        },
        ...r.steps.flatMap((st, i) =>
          st.status === "planned" ? [] : [
            {
              id: 10 + i * 2,
              at: t(2 + i * 3),
              from: "overseer",
              to: st.department + "-leader",
              kind: "assignment",
              body: { step: st.name },
            },
            ...(st.status === "done"
              ? [{
                id: 11 + i * 2,
                at: t(4 + i * 3),
                from: st.department + "-leader",
                to: "overseer",
                kind: "report",
                body: { step: st.name, verified: true, summary: "Done: " + st.name + " verified." },
              }]
              : []),
          ]
        ),
      ],
      events: r.steps.flatMap((st, i) =>
        st.status === "planned" ? [] : [
          { ts: t(2 + i * 3), text: "Step " + (i + 1) + " " + st.name + " started" },
          ...(st.status === "done"
            ? [{ ts: t(4 + i * 3), text: "Step " + (i + 1) + " " + st.name + " verified" }]
            : []),
        ]
      ).reverse(),
      report: { done: done.length },
    };
  };
  async function fetchTab(r, tab) {
    if (demo) return fake(r);
    const base = "/api/requests/" + r.id;
    if (tab === "Transcript") {
      return { messages: (await (await fetch(base + "/transcript")).json()).messages ?? [] };
    }
    if (tab === "Logs") return { events: (await (await fetch(base)).json()).events ?? [] };
    if (tab === "Report") {
      return { report: (await (await fetch(base + "/report")).json()).report ?? null };
    }
    return {};
  }
  function paintDialog() {
    const r = requests.find((x) => x.id === dlgId);
    if (!r || !dlg) return;
    const body = dlg.querySelector(".pb-dbody");
    const tabs = dlg.querySelector(".pb-tabs");
    tabs.replaceChildren(...TABS.map((t) => {
      const b = el("button", "pb-tab" + (t === dlgTab ? " active" : ""), t);
      b.onclick = () => {
        dlgTab = t;
        paintDialog();
      };
      return b;
    }));
    dlg.querySelector(".pb-dtitle").textContent = "Request #" + r.id + " · " + r.project;
    dlg.querySelector(".pb-dsub").textContent = r.description + " · " + (r.playbook ?? "") + " · " +
      (r.waiting ? "waiting on you" : r.state);
    const tab = dlgTab;
    body.replaceChildren(el("p", "pb-meta", "Loading…"));
    if (tab === "Details") {
      const box = el("div");
      box.append(
        el("h4", "", "Spend"),
        el("div", "pb-meta", usd(r.cost) + (r.budget ? " of " + usd(r.budget) : "")),
      );
      const track = el("div", "pb-track");
      const fill = el("div", "pb-fill");
      fill.style.width = Math.min(100, r.budget ? (r.cost / r.budget) * 100 : 0) + "%";
      track.append(fill);
      box.append(track, el("h4", "", "Steps"));
      const ol = el("ol", "pb-list");
      r.steps.forEach((st, i) =>
        ol.append(
          el(
            "li",
            "pb-s-" + st.status,
            (i + 1) + ". " + st.name + " · " + st.department + " · " + st.status,
          ),
        )
      );
      box.append(ol);
      body.replaceChildren(box);
      return;
    }
    fetchTab(r, tab).then((d) => {
      if (dlgId !== r.id || dlgTab !== tab) return;
      const box = el("div");
      if (tab === "Transcript") {
        if (!d.messages.length) box.append(el("p", "pb-meta", "No Messages."));
        for (const m of d.messages) {
          const item = el("div", "pb-msg");
          item.append(
            el("div", "pb-meta", clock(m.at) + " · " + m.from + " → " + m.to + " · " + m.kind),
          );
          const text = Object.entries(m.body ?? {}).map(([k, v]) =>
            k + ": " + (typeof v === "string" ? v : JSON.stringify(v))
          ).join("\n");
          item.append(el("pre", "pb-pre", text.length > 600 ? text.slice(0, 600) + "…" : text));
          box.append(item);
        }
      } else if (tab === "Logs") {
        if (!d.events.length) box.append(el("p", "pb-meta", "Nothing has happened yet."));
        for (const e of d.events) box.append(el("div", "pb-log", clock(e.ts) + " · " + e.text));
      } else {
        const rep = d.report;
        if (!rep) box.append(el("p", "pb-meta", "No report yet."));
        else if (demo) {
          box.append(
            el("h4", "", "Outcome"),
            el(
              "p",
              "",
              r.state === "done" ? "Finished" : r.state === "failed" ? "Failed" : "Still running",
            ),
            el("h4", "", "Progress"),
            el("p", "", rep.done + " of " + r.steps.length + " steps verified"),
            el("h4", "", "Cost"),
            el("p", "", usd(r.cost)),
          );
        } else {
          box.append(el("h4", "", "Outcome"), el("p", "", rep.status));
          if (rep.failure) box.append(el("p", "pb-bad", "Failure: " + rep.failure));
          box.append(el("h4", "", "Steps"));
          for (const st of rep.steps) {
            box.append(el("div", "", st.position + ". " + st.name + " · " + st.status));
            if (st.summary) box.append(el("pre", "pb-pre", st.summary));
          }
          box.append(el("h4", "", "Escalations"));
          if (!rep.escalations.length) box.append(el("p", "pb-meta", "None were raised."));
          for (const e of rep.escalations) {
            box.append(el("div", "", "#" + e.id + " · " + e.status + " · " + e.summary));
          }
          for (const [l, v] of [["Branch", rep.branch], ["Pull request", rep.prUrl]]) {
            if (v) box.append(el("div", "", l + ": " + v));
          }
        }
      }
      body.replaceChildren(box);
    }).catch((err) => body.replaceChildren(el("p", "pb-bad", "Could not load: " + err.message)));
  }
  function openDialog(id) {
    if (!dlg) {
      dlg = el("dialog", "pb-dialog");
      const x = el("button", "pb-x", "✕");
      x.onclick = () => dlg.close();
      dlg.append(
        x,
        el("h3", "pb-dtitle"),
        el("div", "pb-meta pb-dsub"),
        el("div", "pb-tabs"),
        el("div", "pb-dbody"),
      );
      dlg.addEventListener("click", (e) => e.target === dlg && dlg.close()); // backdrop click
      dlg.addEventListener("close", () => {
        dlgId = null;
      });
      document.body.append(dlg);
    }
    dlgId = id;
    dlgTab = "Details";
    paintDialog();
    if (!dlg.open) dlg.showModal();
  }

  // ---- switcher ---------------------------------------------------------------------------
  function switcher() {
    let bar = document.getElementById("pb-switcher");
    if (!bar) {
      bar = el("div");
      bar.id = "pb-switcher";
      document.body.append(bar);
    }
    const keys = Object.keys(VARIANTS);
    const step = (d) => {
      const u = new URL(location.href);
      u.searchParams.set(
        "variant",
        keys[(keys.indexOf(variant()) + d + keys.length) % keys.length],
      );
      history.replaceState(null, "", u);
      paint();
    };
    bar.replaceChildren();
    const prev = el("button", "", "←"), next = el("button", "", "→");
    prev.onclick = () => step(-1);
    next.onclick = () => step(1);
    bar.append(
      prev,
      el("span", "", variant() + " (" + VARIANTS[variant()] + ")" + (demo ? " · demo" : " · live")),
      next,
    );
  }
  addEventListener("keydown", (e) => {
    if (!onBoard() || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
    if (e.key === "ArrowLeft") document.querySelector("#pb-switcher button:first-child")?.click();
    if (e.key === "ArrowRight") document.querySelector("#pb-switcher button:last-child")?.click();
  });

  // ---- lifecycle --------------------------------------------------------------------------
  function paint() {
    if (!onBoard()) {
      document.getElementById("pb-switcher")?.remove();
      panes.classList.remove("pb-full");
      main.classList.remove("pb-main");
      return;
    }
    panes.classList.add("pb-full");
    main.classList.add("pb-main");
    const root = main.querySelector(".pb-root") ?? main.appendChild(el("div", "pb-root"));
    if (variant() === "A") renderA(root);
    else renderB(root);
    switcher();
    if (dlgId !== null && dlgTab === "Details") paintDialog(); // keep Details live
  }

  let timer = null;
  async function start() {
    demo = q().get("demo") === "1";
    if (!demo) {
      try {
        requests = await loadLive();
      } catch {
        requests = [];
      }
      if (requests.length === 0) demo = true;
    }
    if (demo) requests = seedDemo();
    paint();
    clearInterval(timer);
    timer = setInterval(async () => {
      if (!onBoard()) return;
      if (demo) tickDemo();
      else requests = await loadLive().catch(() => requests);
      paint();
    }, demo ? 2500 : 5000);
  }

  // app.js leaves #main alone on /board; we take over once the route is hit.
  const route = () =>
    onBoard() ? (timer ? paint() : start()) : (clearInterval(timer), timer = null, paint());
  addEventListener("popstate", route);
  route();

  const css = el("style");
  css.textContent = `
  #panes.pb-full #rail{display:none}
  .pb-main{padding:1rem;overflow:auto}
  .pb-board{display:flex;gap:.75rem;align-items:flex-start;min-height:70vh}
  .pb-col{flex:1 1 0;min-width:13rem;background:color-mix(in srgb,var(--panel) 70%,transparent);border:1px solid var(--line);border-radius:10px;padding:.5rem}
  .pb-colhead{display:flex;justify-content:space-between;margin:.1rem .25rem .5rem;font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  .pb-count{border:1px solid var(--line);border-radius:999px;padding:0 .5rem}
  .pb-colbody{display:flex;flex-direction:column;gap:.5rem;min-height:4rem}
  .pb-col-failed .pb-colhead{color:#c0392b}.pb-col-done .pb-colhead{color:#1e7e34}
  .pb-card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:.5rem .65rem;cursor:pointer;position:relative}
  .pb-card:hover{border-color:var(--muted)}
  .pb-card.waiting{border-color:#d68a00;box-shadow:0 0 0 1px #d68a00}
  .pb-card.bad{border-color:#c0392b}.pb-card.ok{opacity:.7}
  .pb-head{display:flex;gap:.4rem;font-size:.75rem;color:var(--muted);align-items:center}
  .pb-badge{margin-left:auto;background:#d68a00;color:#fff;border-radius:999px;padding:0 .4rem;font-size:.7rem}
  .pb-title{font-size:.9rem;margin:.2rem 0}
  .pb-track{height:4px;background:var(--line);border-radius:4px;overflow:hidden}
  .pb-fill{height:100%;background:#2d7ff9;transition:width .6s}
  .pb-meta{font-size:.72rem;color:var(--muted);margin-top:.25rem}
  .pb-groups{display:flex;flex-direction:column;gap:1rem}
  .pb-group{border:1px solid var(--line);border-radius:10px;padding:.5rem;background:color-mix(in srgb,var(--panel) 50%,transparent)}
  .pb-grouphead{all:unset;display:flex;gap:.6rem;align-items:center;cursor:pointer;width:100%;padding:.2rem .3rem;font-weight:600;box-sizing:border-box}
  .pb-grouphead:focus-visible{outline:2px solid #2d7ff9}
  .pb-group.open .pb-grouphead{margin-bottom:.5rem}
  .pb-groupname{font-size:1rem}
  .pb-lanes{display:flex;flex-direction:column;gap:.5rem}
  .pb-lane{display:grid;grid-template-columns:9rem 1fr;gap:.5rem;align-items:stretch}
  .pb-cells{display:grid;grid-template-columns:repeat(var(--cols),1fr);position:relative;border:1px solid var(--line);border-radius:8px;background:var(--panel);min-height:4.6rem}
  .pb-lanehead .pb-cells{border-color:transparent;background:none;min-height:0}
  .pb-cellhead{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);padding:0 .25rem;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pb-cell{position:relative;display:flex;align-items:center;justify-content:center}
  .pb-cell::before{content:"";position:absolute;top:50%;left:0;right:0;height:2px;margin-top:-1px;background:var(--line)}
  .pb-cell.first::before{left:50%}.pb-cell.last::before{right:50%}
  .pb-cell.passed::before{background:#1e7e34}
  .pb-cell.passed + .pb-cell::before{background:#1e7e34}
  .pb-cell.passed + .pb-cell:not(.passed)::before{background:linear-gradient(90deg,#1e7e34 50%,var(--line) 50%)}
  .pb-dot{position:relative;z-index:1;width:1.3rem;height:1.3rem;border-radius:50%;border:2px solid var(--line);background:var(--panel);display:flex;align-items:center;justify-content:center;font-size:.75rem;color:#fff;line-height:1}
  .pb-dot.tick{background:#1e7e34;border-color:#1e7e34}
  .pb-dot.fail{background:#c0392b;border-color:#c0392b}
  .pb-token{position:absolute;z-index:3;background:var(--panel);top:4px;bottom:4px;overflow:hidden;transition:left .8s cubic-bezier(.2,.8,.2,1);box-shadow:0 2px 8px #0005}
  .pb-token .pb-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:.8rem}
  .pb-dialog{width:min(44rem,92vw);max-height:80vh;border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--fg);padding:1rem 1.25rem;overflow:auto}
  .pb-dialog::backdrop{background:#0009}
  .pb-x{position:absolute;top:.6rem;right:.8rem;background:none;border:0;color:var(--muted);font-size:1rem;cursor:pointer}
  .pb-dtitle{margin:0 1.5rem .1rem 0}
  .pb-tabs{display:flex;gap:1rem;border-bottom:1px solid var(--line);margin:.75rem 0}
  .pb-tab{background:none;border:0;border-bottom:2px solid transparent;color:var(--muted);padding:.25rem 0;cursor:pointer;font:inherit}
  .pb-tab.active{color:var(--fg);border-bottom-color:var(--fg)}
  .pb-dbody h4{margin:.8rem 0 .2rem}
  .pb-list{padding-left:1.3rem;margin:.2rem 0}.pb-s-done{color:var(--muted)}.pb-s-failed,.pb-bad{color:#c0392b}.pb-s-active{color:#2d7ff9}
  .pb-msg,.pb-log{border-top:1px solid var(--line);padding:.3rem 0;font-size:.85rem}
  .pb-pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:.2rem 0;font:inherit;font-size:.85rem}
  #pb-switcher{position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);display:flex;gap:.75rem;align-items:center;background:#111;color:#fff;padding:.4rem .8rem;border-radius:999px;box-shadow:0 4px 16px #0008;z-index:99;font-size:.85rem}
  #pb-switcher button{background:none;border:0;color:#fff;font-size:1.1rem;cursor:pointer}
  `;
  document.head.append(css);
})();
