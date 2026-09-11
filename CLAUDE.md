# VisualAct — developer notes

Technical reference for whoever (human or AI) works on this codebase next.
User-facing docs are in `README.md`; this file is about how it's built and
why, plus mistakes already made so they aren't repeated.

## Layout

```
hier_dump/    C++ tool, standalone, links against libact
server/       Flask backend (app.py) + VCD parser (vcd_parse.py)
web/          plain JS/SVG frontend, no build step
runs/         per (design,top,prefix) cache dirs, created at runtime
```

## Building hier_dump

**Must use `/opt/homebrew/opt/llvm/bin/clang++`, not the system `c++`.**
`libact.a` in `$ACT_HOME/lib` was built with homebrew LLVM clang; linking
with system clang fails with undefined libc++ symbols like
`std::__1::__hash_memory` (ABI mismatch between libc++ versions). See the
Makefile — it hardcodes this compiler path.

Link line: `-I$ACT_HOME/include -L$ACT_HOME/lib -lact -lvlsilib -ldl`
(confirmed against `actflow_build/scripts/Makefile.std`'s `LIBACT` define).

## hier_dump: libact APIs and why

Load/expand a design (mirrors `actsim/main.cc`'s own startup sequence):
```cpp
Act a(design); a.Expand();
Process *p = a.findProcess(topname, true);
if (!p->isExpanded()) p = p->Expand(ActNamespace::Global(), p->CurScope(), 0, NULL);
```

Walk direct sub-instances of a `Scope*`:
```cpp
ActInstiter it(scope);
for (it = it.begin(); it != it.end(); it++) {
  ValueIdx *vx = *it;
  if (TypeFactory::isParamType(vx->t)) continue;
  if (strcmp(vx->getName(), "self") == 0) continue;
  // TypeFactory::isProcessType(vx->t) -> sub-instance
  // TypeFactory::isChanType(vx->t)    -> local channel var / boundary port
}
```

**Connection resolution** (the core trick): build a dotted string id like
`"instName.portName"` (or just `"channelVarName"` for a local var), parse it
with `ActId::parseId()` (needs a **mutable** buffer — `c_str()` isn't
enough, copy into a `std::vector<char>`), then call
`id->Canonical(scope, /*allow_fail=*/true)`. This returns a union-find
`act_connection*` that's identical for every alias of the same underlying
wire — so group every endpoint (both locally-declared channel variables
*and* bare port-to-port aliases like `a.p = b.q;` with no named channel at
all) by this pointer, and any group of 2+ endpoints is a real channel. This
one mechanism handles both wiring styles uniformly; no special-casing
needed. Verified against real code: `act/transform/testing/state/
refresh_main.cc:70-83` does exactly this pattern.

**Array expansion**: `Array *arr = vx->t->arrayInfo()` on either an
instance's own type (array of sub-instances, e.g. `PE[8][8]`) or a port's
type (array of ports, e.g. `chan!(T) OUT[64];` on an otherwise-scalar
instance) — same class, same API either way. To enumerate every element:
```cpp
Arraystep *as = arr->stepper();
do {
  char *s = as->string();   // e.g. "[0][0]"
  // use s
  as->step();
} while (!as->isend());
delete as;
```
**Gotcha we actually hit (segfault):** `step()` must run *before* checking
`isend()` in the loop condition. An earlier version checked `isend()` prior
to stepping (trying to be clever with a single `&&` expression) and it read
one element past the end, crashing in `Arraystep::string()`. Copy the
do/while pattern above exactly; it matches real usage elsewhere in the
codebase (`act/passes/netgen/emit.cc`, `act/passes/booleanize/booleanize.cc`,
`actsim/core.cc`).

A literal bracket-indexed string like `"PE[0][0]"` parses and resolves fine
through `ActId::parseId()` + `Canonical()` with no special handling needed —
`ActId::parseId` scans digit-only bracket contents and builds an already-
expanded `Array(int idx)` deref itself.

## hier_dump: the focus-path design

`hier_dump <design.act> <SimulatedTopProcess> <outdir> [focus-path]`.
`<design.act>`/`<SimulatedTopProcess>` are **always** the literal values
you'd pass to a real `actsim` invocation — never a "shortcut" file that
skips over a boring testbench wrapper. `[focus-path]` is a dotted instance
path (matching `watch` syntax, e.g. `TB.dut`) from that real top down to
whichever process's own hierarchy to actually dump.

Resolution walks the path one component at a time from the top process's
scope: strip any `[i][j]` suffix to get the lookup name (array index doesn't
affect which process *type* an element is), linear-scan `ActInstiter` for a
matching `ValueIdx`, confirm `isProcessType`, `dynamic_cast<Process*>`, then
`->CurScope()` to descend one level. This same string, unmodified, is also
the prefix applied to every generated channel's watch-name.

This design replaced an earlier, worse one where "which process to dump"
and "what prefix to watch it with" were two separately-typed, easy-to-get-
out-of-sync values (`chip.act`/`top` + a manually-computed `TB.dut`
prefix). That mismatch caused a real bug: the hierarchy's channel names
didn't match the trace's at all, so replay silently showed everything
permanently idle with no error. Don't reintroduce a two-field version of
this.

## actsim facts worth knowing

- No `watch`-all-channels wildcard exists. No CLI flag or script command
  disables the `watch` printf side-effect while keeping VCD recording —
  they're the same `verb & 1` bit in `ChpSim::_chkWatchBreakPt`
  (`actsim/chpsim.cc`). If a user wants a quiet terminal, the caller has to
  redirect actsim's whole stdout to a file themselves (e.g. a Makefile
  target running `actsim ... > actsim_console.txt 2>&1`), since actsim's
  own elaboration phase is *also* very noisy on stdout regardless of watch.
- `cycle` (no argument) runs until natural termination; some older docs/
  examples show `cycle <n>` but that's not this build's syntax.
- VCD encoding for a watched channel (`actsim/tracelib/vcd.cc`): `bz` =
  idle, `bz01`/`bz10` = recv/send-blocked (only distinguishable from idle
  when channel width >= 3 bits — narrower channels can't show "blocked" at
  all), a real bit pattern = active with that value. The `$var` name in the
  VCD is exactly the string passed to `watch`, so there's never a separate
  name-reconciliation step needed between hier_dump's output and the trace.
- Relative `import "..."` in a `.act` file resolves against the process's
  **current working directory**, not the file's own directory or the
  design path being absolute/relative. Any subprocess that runs `actsim` or
  `hier_dump` must `cwd=` into the design file's own directory first (see
  `app.py`'s `/api/hierarchy` and `/api/run` handlers).

## Frontend data model (web/common.js)

Everything (top-level or arbitrarily nested via expand) is addressed by a
**qualified name**: top-level is the plain instance name (`"PE[0][0]"`); a
nested child appends `/localName` per level (`"PE[0][0]/wei_double_buffer"`).
Since each path segment is already the real ACT instance name, `.split("/")
.join(".")` recovers the literal dotted ACT path — this is *the* trick that
let "expand a module in place" reuse `hier_dump` and `/api/hierarchy`
completely unchanged: expanding `qName` just calls `/api/hierarchy` again
with `prefix = existingFocusPath + "." + actPath(qName)`.

`AP.state`:
- `hierarchy` — top-level `{process, instances, channels}` only.
- `floorplan` — `{qualifiedName: {x,y,w,h}}` for *every* visible node at
  any depth.
- `expanded` — `Set<qualifiedName>` of currently-expanded nodes.
- `children` — `Map<qualifiedName, hierarchy>` fetched-and-cached
  sub-hierarchies.

`AP.flattenVisible()` / `AP.flattenChannels()` recursively walk this into a
flat list each render, **pre-order** (parent before its children) — the
frontend relies on this order: appending DOM nodes in this sequence makes
an expanded parent's children naturally paint on top of its (larger)
container box, with no z-index bookkeeping at all. If you ever change the
traversal order, check that still holds.

`floorplan.json` on disk is `{positions, expanded, children}` (children
cached so a reload doesn't need to re-fetch anything). The loader treats a
file with no `positions` key as the old flat `{name:{x,y,w,h}}` format for
backward compatibility — keep that check if you change the schema again.

**The "expand a module in place" UI was removed** (the "Expand selected" /
"Collapse selected" buttons and their handlers in `floorplan.js`) at the
user's request, but this whole underlying model was deliberately left
intact rather than ripped out: `AP.state.expanded`/`children`,
`flattenVisible()`/`flattenChannels()`, `expandInstance()`/
`collapseInstance()` in `common.js` all still exist and work. With no UI
entry point, `expanded` just stays permanently empty, so `flattenVisible()`
always returns exactly the top-level instances — i.e. current behavior is
identical to never having built recursion at all, but re-adding a UI
trigger later is cheap (see git history before this point for the removed
`expandSelected`/`collapseSelected`/`ensureChildLayout` functions in
`floorplan.js` if resurrecting it).

## Channel-status panel (Replay tab)

Selecting module(s) in the Replay canvas (click / Cmd+click / Ctrl+click /
Shift+click — `isMultiKey()` in `replay.js`, independent from Floorplan
tab's own `selected` Set) and clicking "Channel status" opens a side panel
(`#channelPanel`) listing every incident channel of the selected module(s)
with a live status label per channel: **completed** (a real transfer
happened within the activity window), **pending** (currently blocked, part
of a real ongoing exchange), or **idle**. This reuses
`classifyChannel(channelName, time)`, factored out of `colorFor()` so node
coloring and the panel can never disagree about what a given channel is
doing at a given instant. The panel re-renders from `paint()` (so it's live
during play/scrub) but only does any work when `#channelPanel` isn't
`hidden`, to avoid needless DOM churn while it's closed.

## Replay coloring: windowed, not instantaneous

A real VCD "active" event lasts ~1 trace-time-unit; real traces span up to
~10^9 units. Sampling the *exact* current instant shows green almost never,
even for a channel that's constantly busy — this isn't a data bug, it's
just how brief a completed handshake is relative to a trace's length. Fix,
in `replay.js`:

- Green: any incident channel had an "active" event within
  `[time - half, time + half]`, where `half = (activityWindowPct/100) *
  end_time / 2` (a user-adjustable percentage, not a raw time value — an
  earlier version exposed raw time units and it was unusable without
  knowing the trace's timescale).
- Amber ("blocked"): the channel's *exact instantaneous* state is blocked,
  **and** it's had an active event within a much wider window (20x the
  green half-window, `BLOCKED_WINDOW_MULTIPLIER`) — without this second
  check, a channel with only a handful of real transactions total (e.g. a
  once-per-layer flush signal) reads as permanently "busy" for the entire
  trace just because it fired once somewhere, since CHP channels spend the
  overwhelming majority of their time blocked/idle regardless of whether
  they're actually doing meaningful work.

This was empirically tuned against a real large-array design where a
golden-model utilization report said only a handful of processing elements
out of dozens were active for a given input — before this fix, *every*
element showed "blocked" almost always (since any wired-but-unused channel
gets stuck blocked from startup and never resolves); after, unused elements
correctly read idle most of the time. If this regresses, re-derive against
real data rather than guessing constants (sample random timestamps, compare
color distributions for a known-active vs. known-idle module).

## Server gotcha: never test-write against the user's live params

`app.py`'s `_outdir()` hashes `design::top::prefix` to a run directory that
holds `hierarchy.json`, `floorplan.json`, `trace.vcd`. **A `POST` to
`/api/floorplan` (or anything else that writes) using the exact same
design/top/prefix the user has live in their browser will silently
overwrite their real saved work with no backup or version history.** This
happened once during development (a smoke-test `POST` clobbered a user's
real floorplan) — always use an obviously different design file, or at
minimum a distinct dummy prefix, for any test writes. Reads (`GET`) are
safe.

## Testing notes

No Node.js is available in this dev environment for JS syntax-checking —
`python3 -c "print(content.count('('), content.count(')'))"`-style bracket
balance checks were used as a crude sanity check after editing JS, but
that's not a substitute for real verification. Actual correctness was
always confirmed by running the real Flask server and hitting it with
`curl` against real ACT designs (the `119.act` actsim test file for quick
iteration; a larger real-world array-based design for anything
array/prefix/trace-related) — don't trust an untested frontend change;
there's no automated test suite here.

## actsim's hard line-length limit (a real, previously-undocumented bug)

actsim's command-line reader (`miniscm/lispCli.c`) reads each line into a
fixed **10,240-byte** buffer. A single `watch` line listing hundreds of
channels can exceed this — the read silently splits mid-token, corrupting
the parse and dropping every channel after the break point, with no error
that points back at `watch` itself (you'll instead see something like
`Unknown command name '.OUT'` deep in the console output). `hier_dump`
works around this by splitting the generated `watch` command across
multiple lines, each kept under ~8000 bytes — see the `kMaxWatchLineLen`
constant in `hier_dump.cc`. If you ever hand-write or hand-edit a `.scr`
file with a large `watch` list, apply the same split.
