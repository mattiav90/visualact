// Step 2: replay a parsed VCD trace, coloring floorplan nodes by channel activity.
(function () {
  const DEFAULT_W = 100;
  const DEFAULT_H = 44;

  const replay = {
    trace: null, // {end_time, channels: {name: [{t,state}]}}
    incidence: {}, // instName -> [channel name]
    activityWindowPct: 0.5, // % of total trace length; the user-facing knob
    playing: false,
    curTime: 0,
    lastWall: 0,
    selected: new Set(), // qualifiedName of modules selected for the channel panel
  };

  // Multi-select modifier: Cmd on Mac, Ctrl on Windows/Linux, or Shift.
  function isMultiKey(e) {
    return e.shiftKey || e.metaKey || e.ctrlKey;
  }

  function applySelectionClasses() {
    canvas().querySelectorAll(".node").forEach((el) => {
      el.classList.toggle("selected", replay.selected.has(el.dataset.name));
    });
  }

  // Half-window in trace-time-units either side of the current instant,
  // e.g. pct=100 -> half-window covers the whole trace (always "active" if
  // ever active at all); pct=50 -> a window spanning half the trace,
  // centered on the current instant.
  function halfWindow() {
    if (!replay.trace) return 0;
    return (replay.activityWindowPct / 100) * replay.trace.end_time / 2;
  }

  function canvas() { return document.getElementById("replayCanvas"); }

  function ensureSvg() {
    let svg = canvas().querySelector("svg.edges");
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "edges");
      svg.innerHTML =
        '<defs><marker id="arrow2" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">' +
        '<path d="M0,0 L8,4 L0,8 z" fill="#888"/></marker></defs>';
      canvas().appendChild(svg);
    }
    return svg;
  }

  function box(name) {
    const b = AP.state.floorplan[name] || { x: 40, y: 40 };
    return { x: b.x, y: b.y, w: b.w || DEFAULT_W, h: b.h || DEFAULT_H };
  }

  function center(name) {
    if (!AP.state.floorplan[name]) return null;
    const b = box(name);
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }

  function renderStatic() {
    const hier = AP.state.hierarchy;
    if (!hier) return;
    const c = canvas();
    c.querySelectorAll(".node").forEach((n) => n.remove());
    const svg = ensureSvg();
    svg.querySelectorAll("line").forEach((l) => l.remove());

    // Pre-order (parent before children) so nested boxes paint on top of
    // their (larger) expanded parent container -- mirrors the Floorplan
    // tab's rendering so a saved expand/collapse state looks the same here.
    AP.flattenVisible().forEach((node) => {
      const b = box(node.qName);
      const expanded = AP.state.expanded.has(node.qName);
      const el = document.createElement("div");
      el.className = "node" + (expanded ? " container" : "");
      el.dataset.name = node.qName;
      el.style.left = b.x + "px";
      el.style.top = b.y + "px";
      el.style.width = b.w + "px";
      el.style.height = b.h + "px";
      el.innerHTML = `<div class="name">${node.name}</div><div class="type">${node.type}</div>`;
      c.appendChild(el);
      const nameEl = el.querySelector(".name");
      if (AP.state.floorplan[node.qName] && AP.state.floorplan[node.qName].vertical) {
        nameEl.classList.add("vertical");
      }
      nameEl.addEventListener("dblclick", () => {
        const entry = AP.state.floorplan[node.qName];
        if (entry) {
          entry.vertical = !entry.vertical;
          nameEl.classList.toggle("vertical", entry.vertical);
        } else {
          nameEl.classList.toggle("vertical");
        }
      });

      el.addEventListener("click", (e) => {
        if (isMultiKey(e)) {
          if (replay.selected.has(node.qName)) replay.selected.delete(node.qName);
          else replay.selected.add(node.qName);
        } else {
          replay.selected = new Set([node.qName]);
        }
        applySelectionClasses();
        updateChannelPanel();
      });
    });

    applySelectionClasses();

    AP.flattenChannels().forEach((ch) => {
      const a = ch.from ? center(ch.from) : null;
      const b = ch.to ? center(ch.to) : null;
      if (!a && !b) return;
      const p1 = a || { x: 0, y: (b && b.y) || 0 };
      const p2 = b || { x: canvas().clientWidth, y: (a && a.y) || 0 };
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", p1.x);
      line.setAttribute("y1", p1.y);
      line.setAttribute("x2", p2.x);
      line.setAttribute("y2", p2.y);
      line.setAttribute("stroke", "#888");
      line.setAttribute("stroke-width", "1.5");
      line.setAttribute("marker-end", "url(#arrow2)");
      svg.appendChild(line);
    });

    buildIncidence();
    AP.applySearchHighlight("replayCanvas");
  }

  function buildIncidence() {
    replay.incidence = {};
    if (!AP.state.hierarchy) return;
    AP.flattenVisible().forEach((node) => (replay.incidence[node.qName] = []));
    AP.flattenChannels().forEach((ch) => {
      if (ch.from && replay.incidence[ch.from]) replay.incidence[ch.from].push(ch.name);
      if (ch.to && replay.incidence[ch.to]) replay.incidence[ch.to].push(ch.name);
    });
  }

  // binary search: last event with t <= time
  function stateAt(channelName, time) {
    const tl = replay.trace && replay.trace.channels[channelName];
    if (!tl || tl.length === 0) return "idle";
    let lo = 0, hi = tl.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tl[mid].t <= time) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return tl[ans].state;
  }

  // A real transaction ("active") typically lasts only ~1 time unit out of
  // a trace spanning billions, so sampling the EXACT instant almost always
  // misses it even for a channel that's constantly busy -- that's not a bug
  // in the trace, it's just how brief a completed handshake is. Instead,
  // "was this channel active anywhere in [time-half, time+half]" gives a
  // meaningful, visible signal of real throughput near the current instant.
  function hasActiveInWindow(channelName, time, half) {
    const tl = replay.trace && replay.trace.channels[channelName];
    if (!tl || tl.length === 0) return false;
    const from = time - half;
    const to = time + half;
    let lo = 0, hi = tl.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tl[mid].t < from) lo = mid + 1;
      else hi = mid;
    }
    const start = Math.max(0, lo - 1); // include the state already in effect at `from`
    for (let i = start; i < tl.length && tl[i].t <= to; i++) {
      if (tl[i].t >= from && tl[i].state === "active") return true;
    }
    return false;
  }

  // "Blocked" only means something if the channel is part of an ongoing
  // exchange -- checking a much wider window than the "active" one (rather
  // than "ever active in the ENTIRE trace") avoids a channel with a
  // handful of real transactions total (e.g. a once-per-layer flush signal
  // on an otherwise-idle module) reading as permanently "busy" just because
  // it did something once, long ago or far in the future.
  const BLOCKED_WINDOW_MULTIPLIER = 20;

  // Single per-channel classification, shared by node coloring and the
  // channel-status panel so they always agree: "active" = just completed a
  // real transfer (within the activity window), "blocked" = currently
  // waiting on a handshake partner (and part of a real ongoing exchange,
  // not just a wire that's never once been used), "idle" = neither.
  function classifyChannel(channelName, time) {
    const half = halfWindow();
    if (hasActiveInWindow(channelName, time, half)) return "active";
    const blockedHalf = half * BLOCKED_WINDOW_MULTIPLIER;
    if (stateAt(channelName, time) === "blocked" && hasActiveInWindow(channelName, time, blockedHalf)) {
      return "blocked";
    }
    return "idle";
  }

  function colorFor(instName, time) {
    const chans = replay.incidence[instName] || [];
    let sawBlocked = false;
    for (const ch of chans) {
      const c = classifyChannel(ch, time);
      if (c === "active") return "active";
      if (c === "blocked") sawBlocked = true;
    }
    return sawBlocked ? "blocked" : "idle";
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  const PANEL_LABEL = { active: "completed", blocked: "pending", idle: "idle" };

  function updateChannelPanel() {
    const panel = document.getElementById("channelPanel");
    if (panel.hidden) return;
    const body = document.getElementById("channelPanelBody");
    const title = document.getElementById("channelPanelTitle");
    title.textContent = `Channel status — t = ${Math.floor(replay.curTime)}`;

    const targets = Array.from(replay.selected);
    if (!targets.length) {
      body.innerHTML =
        '<div class="empty-hint">No modules selected. Click one or more modules in the canvas (Cmd/Ctrl/Shift-click to select several) to see their channels here.</div>';
      return;
    }

    let html = "";
    targets.forEach((qName) => {
      html += `<div class="proc-heading">${escapeHtml(qName)}</div>`;
      const chans = replay.incidence[qName] || [];
      if (!chans.length) {
        html += '<div class="empty-hint">(no channels)</div>';
        return;
      }
      chans.forEach((ch) => {
        const cls = classifyChannel(ch, replay.curTime);
        html +=
          `<div class="channel-row"><span class="chname" title="${escapeHtml(ch)}">` +
          `${escapeHtml(ch)}</span><span class="chstate ${cls === "active" ? "completed" : cls === "blocked" ? "pending" : "idle"}">` +
          `${PANEL_LABEL[cls]}</span></div>`;
      });
    });
    body.innerHTML = html;
  }

  function paint(time) {
    canvas().querySelectorAll(".node").forEach((el) => {
      const name = el.dataset.name;
      const c = colorFor(name, time);
      el.classList.toggle("active", c === "active");
      el.classList.toggle("blocked", c === "blocked");
    });
    document.getElementById("timeLabel").textContent = `t = ${Math.floor(time)}`;
    updateChannelPanel();
  }

  function seek(time) {
    replay.curTime = Math.max(0, Math.min(time, replay.trace ? replay.trace.end_time : 0));
    document.getElementById("scrubber").value = replay.curTime;
    paint(replay.curTime);
  }

  function tick(nowMs) {
    if (!replay.playing) return;
    const speed = parseFloat(document.getElementById("speedSelect").value);
    const dtMs = nowMs - replay.lastWall;
    replay.lastWall = nowMs;
    seek(replay.curTime + dtMs * speed);
    if (replay.curTime >= replay.trace.end_time) {
      setPlaying(false);
      return;
    }
    requestAnimationFrame(tick);
  }

  function setPlaying(on) {
    replay.playing = on;
    document.getElementById("playPauseBtn").textContent = on ? "⏸ Pause" : "▶️ Play";
    if (on) {
      replay.lastWall = performance.now();
      requestAnimationFrame(tick);
    }
  }

  async function runSim() {
    const status = document.getElementById("replayStatus");
    status.textContent = "running actsim...";
    try {
      const res = await AP.postJSON(`/api/run?${AP.params()}`, {});
      if (!res.ok) {
        status.textContent = `actsim failed (see console)`;
        console.error(res.stdout, res.stderr);
        return;
      }
      status.textContent = "simulation complete, loading trace...";
      await loadTrace();
    } catch (e) {
      status.textContent = `error: ${e.message}`;
    }
  }

  async function loadTrace() {
    const status = document.getElementById("replayStatus");
    if (!AP.state.hierarchy || !Object.keys(AP.state.floorplan).length) {
      status.textContent = "load + save a floorplan in tab 1 first";
      return;
    }
    try {
      status.textContent = "loading trace...";
      const override = document.getElementById("vcdOverride").value.trim();
      const params = AP.params();
      if (override) params.set("vcd", override);
      const trace = await AP.getJSON(`/api/trace?${params}`);
      replay.trace = trace;

      document.getElementById("activityWindow").value = replay.activityWindowPct;

      renderStatic();
      document.getElementById("scrubber").max = trace.end_time;
      seek(0);

      // Coloring depends on hierarchy.json's channel names exactly matching
      // the trace's -- if the watch-prefix used to load the hierarchy
      // doesn't match what's baked into the .scr that produced this trace,
      // every lookup misses and everything looks permanently idle. Surface
      // that mismatch immediately instead of failing silently.
      const hierNames = AP.flattenChannels().map((c) => c.name);
      const traceNames = new Set(Object.keys(trace.channels));
      const matched = hierNames.filter((n) => traceNames.has(n)).length;
      let msg = `trace loaded, end_time=${trace.end_time}, ${matched}/${hierNames.length} channels matched`;
      if (matched === 0 && hierNames.length > 0) {
        msg += ` -- NO channel names match. Check the Watch-prefix field matches what was used to generate the .scr that produced this trace.`;
        console.warn("hierarchy channel names (sample):", hierNames.slice(0, 3));
        console.warn("trace channel names (sample):", Array.from(traceNames).slice(0, 3));
      }
      status.textContent = msg;
    } catch (e) {
      status.textContent = `error: ${e.message}`;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("runSimBtn").addEventListener("click", runSim);
    document.getElementById("loadTraceBtn").addEventListener("click", loadTrace);
    document.getElementById("playPauseBtn").addEventListener("click", () =>
      setPlaying(!replay.playing)
    );
    document.getElementById("scrubber").addEventListener("input", (e) => {
      setPlaying(false);
      seek(parseFloat(e.target.value));
    });
    document.getElementById("activityWindow").addEventListener("input", (e) => {
      replay.activityWindowPct = Math.min(100, Math.max(0, parseFloat(e.target.value) || 0));
      paint(replay.curTime);
    });
    document.getElementById("channelStatusBtn").addEventListener("click", () => {
      document.getElementById("channelPanel").hidden = false;
      updateChannelPanel();
    });
    document.getElementById("closeChannelPanel").addEventListener("click", () => {
      document.getElementById("channelPanel").hidden = true;
    });
    document.getElementById("addSearchMatchesBtn").addEventListener("click", () => {
      const matches = canvas().querySelectorAll(".node.search-match");
      if (!matches.length) {
        document.getElementById("replayStatus").textContent =
          "no search matches -- type something in the search box first";
        return;
      }
      matches.forEach((el) => replay.selected.add(el.dataset.name));
      applySelectionClasses();
      document.getElementById("channelPanel").hidden = false;
      updateChannelPanel();
    });
    window.addEventListener("resize", renderStatic);
  });
})();
