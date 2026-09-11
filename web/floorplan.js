// Step 1: hierarchy graph viewer + draggable, resizable, expandable floorplan
// editor. See common.js for the qualified-name / expand-a-node model this
// all builds on.
(function () {
  const DEFAULT_W = 100;
  const DEFAULT_H = 44;
  const MIN_W = 40;
  const MIN_H = 28;

  const selected = new Set();

  function canvas() { return document.getElementById("floorplanCanvas"); }

  function ensureSvg() {
    let svg = canvas().querySelector("svg.edges");
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "edges");
      svg.innerHTML =
        '<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">' +
        '<path d="M0,0 L8,4 L0,8 z" fill="#888"/></marker></defs>';
      canvas().appendChild(svg);
    }
    return svg;
  }

  function box(qName) {
    const b = AP.state.floorplan[qName];
    if (!b) return null;
    return {
      x: b.x,
      y: b.y,
      w: b.w || DEFAULT_W,
      h: b.h || DEFAULT_H,
    };
  }

  function center(qName) {
    const b = box(qName);
    if (!b) return null;
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }

  function nodeEl(qName) {
    return canvas().querySelector(`.node[data-name="${CSS.escape(qName)}"]`);
  }

  function applySelectionClasses() {
    canvas().querySelectorAll(".node").forEach((el) => {
      el.classList.toggle("selected", selected.has(el.dataset.name));
    });
  }

  function setSelected(names) {
    selected.clear();
    names.forEach((n) => selected.add(n));
    applySelectionClasses();
  }

  function toggleSelected(name) {
    if (selected.has(name)) selected.delete(name);
    else selected.add(name);
    applySelectionClasses();
  }

  // "Base[0][3]" -> {base: "Base", idx: [0, 3]}; a name with no bracket
  // suffix -> {base: name, idx: null} (a scalar, non-arrayed instance).
  const ARRAY_NAME_RE = /^(.*?)((?:\[\d+\])+)$/;
  function parseInstName(name) {
    const m = name.match(ARRAY_NAME_RE);
    if (!m) return { base: name, idx: null };
    const idx = Array.from(m[2].matchAll(/\[(\d+)\]/g)).map((x) => parseInt(x[1], 10));
    return { base: m[1], idx };
  }

  // Groups array instances (e.g. PE[i][j]) into an actual row/col grid
  // matching their real indices, lays out 1-D arrays as a single strip, and
  // flows scalar instances and array blocks left-to-right, wrapping into a
  // new row once a block would exceed maxRowWidth. Returns ABSOLUTE
  // positions (already offset by originX/originY) using each instance's
  // LOCAL name -- the caller is responsible for qualifying them if nesting.
  function computeLayout(instances, originX, originY) {
    const gapX = DEFAULT_W + 20;
    const gapY = DEFAULT_H + 20;
    const groupGap = 40;
    const maxRowWidth = 1600;

    const groups = new Map(); // base -> [{name, idx}]
    instances.forEach((inst) => {
      const parsed = parseInstName(inst.name);
      if (!groups.has(parsed.base)) groups.set(parsed.base, []);
      groups.get(parsed.base).push({ name: inst.name, idx: parsed.idx });
    });

    const positions = [];
    let cursorX = 0, cursorY = 0, rowHeight = 0, maxX = 0;

    groups.forEach((members) => {
      const local = []; // {name, x, y} local to this group's own origin
      let groupW, groupH;

      if (members[0].idx === null) {
        local.push({ name: members[0].name, x: 0, y: 0 });
        groupW = DEFAULT_W;
        groupH = DEFAULT_H;
      } else if (members[0].idx.length === 1) {
        members.sort((a, b) => a.idx[0] - b.idx[0]);
        members.forEach((m, i) => local.push({ name: m.name, x: i * gapX, y: 0 }));
        groupW = members.length * gapX - (gapX - DEFAULT_W);
        groupH = DEFAULT_H;
      } else {
        // 2-D (or higher -- only the first two index dimensions place the
        // node; further dimensions, if any, collapse onto the same cell).
        let maxRow = 0, maxCol = 0;
        members.forEach((m) => {
          maxRow = Math.max(maxRow, m.idx[0]);
          maxCol = Math.max(maxCol, m.idx[1]);
        });
        members.forEach((m) => {
          local.push({ name: m.name, x: m.idx[1] * gapX, y: m.idx[0] * gapY });
        });
        groupW = (maxCol + 1) * gapX - (gapX - DEFAULT_W);
        groupH = (maxRow + 1) * gapY - (gapY - DEFAULT_H);
      }

      if (cursorX > 0 && cursorX + groupW > maxRowWidth) {
        cursorX = 0;
        cursorY += rowHeight + groupGap;
        rowHeight = 0;
      }

      local.forEach((p) => {
        positions.push({ name: p.name, x: originX + cursorX + p.x, y: originY + cursorY + p.y });
      });
      maxX = Math.max(maxX, cursorX + groupW);
      cursorX += groupW + groupGap;
      rowHeight = Math.max(rowHeight, groupH);
    });

    return { positions, width: maxX, height: cursorY + rowHeight };
  }

  function autoLayout() {
    const hier = AP.state.hierarchy;
    if (!hier) return;
    const { positions } = computeLayout(hier.instances, 20, 20);
    positions.forEach((p) => {
      AP.state.floorplan[p.name] = { x: p.x, y: p.y, w: DEFAULT_W, h: DEFAULT_H };
    });
    render();
  }

  // Lay a just-expanded node's children out inside/below its current box
  // (unless they already have saved positions, e.g. from a reloaded
  // floorplan), and grow the parent box to fit them.
  function ensureChildLayout(qName, childHier) {
    const alreadyPositioned = childHier.instances.some(
      (i) => AP.state.floorplan[`${qName}/${i.name}`]
    );
    if (alreadyPositioned) return;

    const pad = 10, headerH = 26;
    const parentBox = box(qName) || { x: 20, y: 20, w: DEFAULT_W, h: DEFAULT_H };
    const { positions, width, height } = computeLayout(
      childHier.instances,
      parentBox.x + pad,
      parentBox.y + headerH
    );
    positions.forEach((p) => {
      AP.state.floorplan[`${qName}/${p.name}`] = { x: p.x, y: p.y, w: DEFAULT_W, h: DEFAULT_H };
    });

    const b = AP.state.floorplan[qName];
    b.w = Math.max(b.w || DEFAULT_W, width + pad * 2);
    b.h = Math.max(b.h || DEFAULT_H, height + headerH + pad);
  }

  async function expandSelected() {
    const status = document.getElementById("floorplanStatus");
    const targets = Array.from(selected);
    if (!targets.length) {
      status.textContent = "select one or more modules first";
      return;
    }
    status.textContent = `expanding ${targets.length} module(s)...`;
    for (const qName of targets) {
      try {
        await AP.expandInstance(qName);
        const child = AP.state.children.get(qName);
        if (child) ensureChildLayout(qName, child);
      } catch (e) {
        status.textContent = `expand failed for ${qName}: ${e.message}`;
        render();
        return;
      }
    }
    render();
    status.textContent = `expanded ${targets.length} module(s)`;
  }

  function collapseSelected() {
    const targets = Array.from(selected);
    if (!targets.length) return;
    targets.forEach((qName) => AP.collapseInstance(qName));
    render();
  }

  // Dragging any node in the current selection moves every selected node
  // (and, for an expanded one, everything nested inside it) together;
  // dragging a node outside the selection selects just that one first
  // (unless shift is held, which only toggles membership and does not
  // start a drag).
  function makeDraggable(el, qName) {
    let dragging = false;
    let startX, startY;
    let origins = null; // Map<qName, {x,y}> snapshot at drag start

    el.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("resize-handle")) return;
      e.stopPropagation(); // don't let this bubble into the canvas marquee handler

      if (e.shiftKey) {
        toggleSelected(qName);
        return;
      }

      if (!selected.has(qName)) {
        setSelected([qName]);
      }

      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      origins = new Map();
      const toMove = new Set();
      selected.forEach((n) => {
        toMove.add(n);
        AP.descendantsOf(n).forEach((d) => toMove.add(d));
      });
      toMove.forEach((n) => {
        const b = AP.state.floorplan[n];
        if (b) origins.set(n, { x: b.x, y: b.y });
        nodeEl(n) && nodeEl(n).classList.add("dragging");
      });
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      origins.forEach((orig, n) => {
        const b = AP.state.floorplan[n];
        if (!b) return;
        b.x = Math.max(0, orig.x + dx);
        b.y = Math.max(0, orig.y + dy);
        const nel = nodeEl(n);
        if (nel) {
          nel.style.left = b.x + "px";
          nel.style.top = b.y + "px";
        }
      });
      drawEdges();
    });

    window.addEventListener("mouseup", () => {
      if (dragging) {
        dragging = false;
        origins.forEach((_, n) => {
          const nel = nodeEl(n);
          if (nel) nel.classList.remove("dragging");
        });
        origins = null;
      }
    });
  }

  // Every other currently-visible instance of the same process type (e.g.
  // every PE[i][j], all sharing type "Processing_Element<>") resizes
  // together, since they're visually meant to represent the same module --
  // this applies at any nesting depth, not just top-level.
  function sameTypeNames(qName) {
    const visible = AP.flattenVisible();
    const node = visible.find((n) => n.qName === qName);
    if (!node) return [qName];
    return visible.filter((n) => n.type === node.type).map((n) => n.qName);
  }

  // Double-click a node's name label to rotate it vertical (useful once a
  // box is resized narrow/tall); double-click again to go back to
  // horizontal. Plain single click still just selects the node as usual.
  function makeNameToggle(nameEl) {
    nameEl.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      nameEl.classList.toggle("vertical");
    });
  }

  function makeResizable(el, handle, qName) {
    let resizing = false;
    let startX, startY, origW, origH;
    let peers = null;

    handle.addEventListener("mousedown", (e) => {
      resizing = true;
      startX = e.clientX;
      startY = e.clientY;
      const b = AP.state.floorplan[qName];
      origW = b.w || DEFAULT_W;
      origH = b.h || DEFAULT_H;
      peers = sameTypeNames(qName);
      e.preventDefault();
      e.stopPropagation();
    });

    window.addEventListener("mousemove", (e) => {
      if (!resizing) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const w = Math.max(MIN_W, origW + dx);
      const h = Math.max(MIN_H, origH + dy);
      peers.forEach((n) => {
        const b = AP.state.floorplan[n];
        if (!b) return;
        b.w = w;
        b.h = h;
        const nel = nodeEl(n);
        if (nel) {
          nel.style.width = w + "px";
          nel.style.height = h + "px";
        }
      });
      drawEdges();
    });

    window.addEventListener("mouseup", () => {
      resizing = false;
      peers = null;
    });
  }

  // Click-drag on empty canvas draws a selection rectangle; every node it
  // overlaps (at any nesting depth) becomes the new selection. A plain
  // click with no drag clears the selection.
  function setupMarquee() {
    const c = canvas();
    let active = false;
    let startX, startY;
    let rectEl = null;

    function canvasPoint(e) {
      const rect = c.getBoundingClientRect();
      return {
        x: e.clientX - rect.left + c.scrollLeft,
        y: e.clientY - rect.top + c.scrollTop,
      };
    }

    function intersects(a, b) {
      return !(b.x > a.x + a.w || b.x + b.w < a.x || b.y > a.y + a.h || b.y + b.h < a.y);
    }

    c.addEventListener("mousedown", (e) => {
      if (e.target !== c) return; // only start on empty canvas background
      active = true;
      const p = canvasPoint(e);
      startX = p.x;
      startY = p.y;
      rectEl = document.createElement("div");
      rectEl.className = "marquee";
      rectEl.style.left = startX + "px";
      rectEl.style.top = startY + "px";
      rectEl.style.width = "0px";
      rectEl.style.height = "0px";
      c.appendChild(rectEl);
      if (!e.shiftKey) setSelected([]);
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!active) return;
      const p = canvasPoint(e);
      const x = Math.min(startX, p.x);
      const y = Math.min(startY, p.y);
      const w = Math.abs(p.x - startX);
      const h = Math.abs(p.y - startY);
      rectEl.style.left = x + "px";
      rectEl.style.top = y + "px";
      rectEl.style.width = w + "px";
      rectEl.style.height = h + "px";

      const marqueeBox = { x, y, w, h };
      AP.flattenVisible().forEach((node) => {
        const b = box(node.qName);
        if (!b) return;
        const hit = intersects(marqueeBox, b);
        const nel = nodeEl(node.qName);
        if (!nel) return;
        if (hit) {
          selected.add(node.qName);
        } else if (!e.shiftKey) {
          selected.delete(node.qName);
        }
        nel.classList.toggle("selected", selected.has(node.qName));
      });
    });

    window.addEventListener("mouseup", () => {
      if (!active) return;
      active = false;
      if (rectEl) {
        rectEl.remove();
        rectEl = null;
      }
    });
  }

  function drawEdges() {
    const hier = AP.state.hierarchy;
    if (!hier) return;
    const svg = ensureSvg();
    svg.querySelectorAll("line").forEach((l) => l.remove());

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
      line.setAttribute("marker-end", "url(#arrow)");
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = ch.name;
      line.appendChild(title);
      svg.appendChild(line);
    });
  }

  function render() {
    const hier = AP.state.hierarchy;
    if (!hier) return;
    const c = canvas();
    c.querySelectorAll(".node").forEach((n) => n.remove());
    selected.clear();
    ensureSvg();

    // Pre-order: a parent always precedes its own children, so appending in
    // this order makes children paint on top of their (larger) parent
    // container box with no z-index bookkeeping needed.
    AP.flattenVisible().forEach((node) => {
      if (!AP.state.floorplan[node.qName]) {
        AP.state.floorplan[node.qName] = { x: 20, y: 20, w: DEFAULT_W, h: DEFAULT_H };
      }
      const b = box(node.qName);
      const expanded = AP.state.expanded.has(node.qName);
      const el = document.createElement("div");
      el.className = "node" + (expanded ? " container" : "");
      el.dataset.name = node.qName;
      el.style.left = b.x + "px";
      el.style.top = b.y + "px";
      el.style.width = b.w + "px";
      el.style.height = b.h + "px";
      el.innerHTML =
        `<div class="name">${node.name}</div><div class="type">${node.type}</div>` +
        `<div class="resize-handle" title="drag to resize"></div>`;
      c.appendChild(el);
      makeDraggable(el, node.qName);
      makeResizable(el, el.querySelector(".resize-handle"), node.qName);
      makeNameToggle(el.querySelector(".name"));
    });

    drawEdges();
  }

  async function load() {
    AP.saveInputs();
    const status = document.getElementById("floorplanStatus");
    status.textContent = "loading hierarchy...";
    try {
      const p = AP.params();
      p.set("force", "1");
      const hier = await AP.getJSON(`/api/hierarchy?${p}`);
      AP.state.hierarchy = hier;

      const saved = await AP.getJSON(`/api/floorplan?${AP.params()}`);
      if (saved && saved.positions) {
        AP.state.floorplan = saved.positions;
        AP.state.expanded = new Set(saved.expanded || []);
        AP.state.children = new Map(Object.entries(saved.children || {}));
      } else if (saved && Object.keys(saved).length) {
        // old flat {qName: {x,y,w,h}} format from before expand/collapse existed
        AP.state.floorplan = saved;
        AP.state.expanded = new Set();
        AP.state.children = new Map();
      } else {
        AP.state.floorplan = {};
        AP.state.expanded = new Set();
        AP.state.children = new Map();
      }

      if (!Object.keys(AP.state.floorplan).length) {
        autoLayout();
      } else {
        render();
      }
      status.textContent = `${hier.instances.length} instances, ${hier.channels.length} channels`;
    } catch (e) {
      status.textContent = `error: ${e.message}`;
    }
  }

  async function save() {
    const status = document.getElementById("floorplanStatus");
    try {
      const payload = {
        positions: AP.state.floorplan,
        expanded: Array.from(AP.state.expanded),
        children: Object.fromEntries(AP.state.children),
      };
      await AP.postJSON(`/api/floorplan?${AP.params()}`, payload);
      status.textContent = "floorplan saved";
    } catch (e) {
      status.textContent = `error: ${e.message}`;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("loadBtn").addEventListener("click", load);
    document.getElementById("autoLayoutBtn").addEventListener("click", autoLayout);
    document.getElementById("saveFloorplanBtn").addEventListener("click", save);
    document.getElementById("expandBtn").addEventListener("click", expandSelected);
    document.getElementById("collapseBtn").addEventListener("click", collapseSelected);
    window.addEventListener("resize", drawEdges);
    setupMarquee();
  });

  window.AP_floorplan = { render, drawEdges, box };
})();
