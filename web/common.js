// Shared state + helpers used by floorplan.js and replay.js.
//
// Expandable hierarchy model: an instance can be "expanded" to reveal its
// own sub-instances nested inside it. Every visible node (top-level or
// nested, at any depth) is identified by a "qualified name" -- top-level
// instances use their plain name (e.g. "PE[0][0]"); a nested child appends
// "/localName" per level (e.g. "PE[0][0]/wei_double_buffer"). Since each
// path segment is already the exact ACT instance name, joining segments
// with "." instead of "/" recovers the real dotted ACT path -- so no
// separate bookkeeping is needed to know what to ask hier_dump for when
// expanding a node.
const AP = (function () {
  const state = {
    hierarchy: null, // {process, instances:[{name,type}], channels:[{name,from,to}]} -- top level
    floorplan: {}, // {qualifiedName: {x,y,w,h}} -- every visible node, any depth
    expanded: new Set(), // qualifiedName of every currently-expanded instance
    children: new Map(), // qualifiedName -> {process, instances, channels} (fetched + cached)
  };

  function designInput() { return document.getElementById("designPath"); }
  function topInput() { return document.getElementById("topProc"); }
  function prefixInput() { return document.getElementById("watchPrefix"); }

  function restoreInputs() {
    designInput().value = localStorage.getItem("ap.design") || "";
    topInput().value = localStorage.getItem("ap.top") || "";
    prefixInput().value = localStorage.getItem("ap.prefix") || "";
  }

  function saveInputs() {
    localStorage.setItem("ap.design", designInput().value.trim());
    localStorage.setItem("ap.top", topInput().value.trim());
    localStorage.setItem("ap.prefix", prefixInput().value.trim());
    recordHistory("designPath", designInput().value);
    recordHistory("topProc", topInput().value);
    recordHistory("watchPrefix", prefixInput().value);
  }

  // Per-field "recently used" history, backing a native <datalist> dropdown
  // on each text input -- click into the field (or start typing) and the
  // browser shows past values so paths/names don't need retyping every time.
  const MAX_HISTORY = 10;

  function historyKey(fieldId) {
    return `ap.history.${fieldId}`;
  }

  function getHistory(fieldId) {
    try {
      return JSON.parse(localStorage.getItem(historyKey(fieldId)) || "[]");
    } catch (e) {
      return [];
    }
  }

  function populateDatalist(fieldId) {
    const list = document.getElementById(`${fieldId}List`);
    if (!list) return;
    list.innerHTML = getHistory(fieldId)
      .map((v) => `<option value="${v.replace(/"/g, "&quot;")}"></option>`)
      .join("");
  }

  function recordHistory(fieldId, value) {
    value = (value || "").trim();
    if (!value) return;
    let hist = getHistory(fieldId).filter((v) => v !== value);
    hist.unshift(value);
    if (hist.length > MAX_HISTORY) hist = hist.slice(0, MAX_HISTORY);
    localStorage.setItem(historyKey(fieldId), JSON.stringify(hist));
    populateDatalist(fieldId);
  }

  // design+top+prefix together identify a run dir on the server (the
  // prefix changes the channel names hierarchy.json/watch_all.scr generate,
  // so it has to stay consistent across hierarchy/floorplan/run/trace calls
  // for the same logical run).
  function params() {
    const p = new URLSearchParams({
      design: designInput().value.trim(),
      top: topInput().value.trim(),
    });
    const prefix = prefixInput().value.trim();
    if (prefix) p.set("prefix", prefix);
    return p;
  }

  // "PE[0][0]/wei_double_buffer/wei_buf[1]" -> "PE[0][0].wei_double_buffer.wei_buf[1]"
  function actPath(qualifiedName) {
    return qualifiedName.split("/").join(".");
  }

  // The dotted focus-path to pass to hier_dump for THIS node's own
  // children -- the design/top's own focus path (from the header field)
  // plus the qualified name's dotted ACT path.
  function focusPathFor(qualifiedName) {
    const globalPrefix = prefixInput().value.trim();
    const path = actPath(qualifiedName);
    return globalPrefix ? `${globalPrefix}.${path}` : path;
  }

  function localLabel(qualifiedName) {
    const idx = qualifiedName.lastIndexOf("/");
    return idx === -1 ? qualifiedName : qualifiedName.slice(idx + 1);
  }

  // Every currently-visible node (top-level plus every expanded node's
  // children, recursively), in pre-order (a parent always precedes its
  // children -- rendering in this order makes children paint on top of
  // their parent's container box with no z-index bookkeeping needed).
  function flattenVisible() {
    const out = [];
    function walk(instances, parentQName, depth) {
      instances.forEach((inst) => {
        const qName = parentQName ? `${parentQName}/${inst.name}` : inst.name;
        out.push({ qName, name: inst.name, type: inst.type, depth, parentQName });
        if (state.expanded.has(qName) && state.children.has(qName)) {
          walk(state.children.get(qName).instances, qName, depth + 1);
        }
      });
    }
    if (state.hierarchy) walk(state.hierarchy.instances, null, 0);
    return out;
  }

  // Every channel across the whole visible tree: top-level channels plus
  // each expanded node's own internal channels, with from/to qualified
  // relative to that node so they resolve against state.floorplan.
  function flattenChannels() {
    const out = [];
    function addAll(channels, parentQName) {
      channels.forEach((ch) => {
        out.push({
          name: ch.name,
          from: ch.from ? (parentQName ? `${parentQName}/${ch.from}` : ch.from) : null,
          to: ch.to ? (parentQName ? `${parentQName}/${ch.to}` : ch.to) : null,
        });
      });
    }
    if (state.hierarchy) addAll(state.hierarchy.channels, null);
    state.expanded.forEach((qName) => {
      const child = state.children.get(qName);
      if (child) addAll(child.channels, qName);
    });
    return out;
  }

  // All qualified names nested (at any depth) under qName, from the
  // currently-visible tree -- used so dragging/collapsing a container also
  // affects everything inside it.
  function descendantsOf(qName) {
    return flattenVisible()
      .filter((n) => n.qName.startsWith(qName + "/"))
      .map((n) => n.qName);
  }

  async function expandInstance(qName) {
    if (!state.children.has(qName)) {
      const p = new URLSearchParams({
        design: designInput().value.trim(),
        top: topInput().value.trim(),
        prefix: focusPathFor(qName),
      });
      const childHier = await getJSON(`/api/hierarchy?${p}`);
      state.children.set(qName, childHier);
    }
    state.expanded.add(qName);
  }

  function collapseInstance(qName) {
    state.expanded.delete(qName);
  }

  async function getJSON(url) {
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `request failed: ${url}`);
    return body;
  }

  async function postJSON(url, data) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data || {}),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `request failed: ${url}`);
    return body;
  }

  function setTab(name) {
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === name);
    });
    document.querySelectorAll(".view").forEach((v) => {
      v.classList.toggle("active", v.id === `${name}-view`);
    });
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const btn = document.getElementById("themeToggle");
    btn.textContent = theme === "dark" ? "\u{1F319}" : "☀️"; // moon : sun
  }

  // Highlights every rendered node in the given canvas whose qualified
  // name contains the current search box text (case-insensitive substring
  // match). Called both on every keystroke and after any re-render (since
  // rebuilding a canvas's nodes wipes whatever classes were on the old
  // elements) -- safe to call any time, does nothing if the canvas is
  // empty or the search box is blank (just clears any stale highlights).
  function applySearchHighlight(canvasId) {
    const canvasEl = document.getElementById(canvasId);
    if (!canvasEl) return;
    const query = (document.getElementById("searchBox").value || "").trim().toLowerCase();
    canvasEl.querySelectorAll(".node").forEach((el) => {
      const match = query.length > 0 && el.dataset.name.toLowerCase().includes(query);
      el.classList.toggle("search-match", match);
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    restoreInputs();
    ["designPath", "topProc", "watchPrefix", "vcdOverride"].forEach(populateDatalist);
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.addEventListener("click", () => setTab(b.dataset.tab));
    });

    const themeBtn = document.getElementById("themeToggle");
    let theme = localStorage.getItem("ap.theme") || "light";
    applyTheme(theme);
    themeBtn.addEventListener("click", () => {
      theme = theme === "dark" ? "light" : "dark";
      applyTheme(theme);
      localStorage.setItem("ap.theme", theme);
    });

    document.getElementById("searchBox").addEventListener("input", () => {
      applySearchHighlight("floorplanCanvas");
      applySearchHighlight("replayCanvas");
    });
  });

  return {
    state,
    params,
    getJSON,
    postJSON,
    saveInputs,
    setTab,
    actPath,
    focusPathFor,
    localLabel,
    flattenVisible,
    flattenChannels,
    descendantsOf,
    expandInstance,
    collapseInstance,
    applySearchHighlight,
    recordHistory,
  };
})();
