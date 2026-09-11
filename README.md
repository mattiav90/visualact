# VisualAct

VisualAct is a tool for looking at ACT designs that you simulate with
`actsim`. It has two parts:

1. **Floorplan** — shows the modules in your design and how they connect,
   as boxes and lines you can drag around and arrange however you like.
2. **Replay** — plays back a finished simulation and colors each module
   green when it's doing work, yellow when it's waiting, and white when
   it's idle. A side panel can also show the exact status of every channel
   on any module(s) you pick.

VisualAct does not change anything in ACT or actsim. It only reads your
`.act` files.

## How it works with actsim

`actsim` already has a way to record activity: you tell it `watch <name>`
for a channel, and `vcd_start <file>` to save what happens on every watched
channel to a file, with timestamps.

VisualAct comes with a small tool called `hier_dump`. You point it at your
design and it does two things:

- Writes `hierarchy.json`: the list of modules in your design and how they
  are wired together. If a module is an array (like `PE[8][8]`), it lists
  every element separately (`PE[0][0]`, `PE[0][1]`, ...).
- Writes `watch_all.scr`: a script with a `watch` command for every channel
  it found, ready to hand to actsim.

You run the simulation yourself, the normal way you always do. VisualAct
does not run or control your simulation — it just reads the trace file that
comes out of it.

## Setting up a simulation to use it

1. Build `hier_dump` (see Build, below).
2. Run it with the same file and top process you would give to actsim:
   ```
   hier_dump <design.act> <TopProcess> <outdir> [focus-path]
   ```
   `[focus-path]` is optional. Use it if the module you actually want to
   look at is nested inside something else (like a test bench). For
   example if your top process is `top`, and `top` contains `TB`, and `TB`
   contains `space`, and `space` is the part you actually care about, then
   the focus path is `TB.space`.
3. Open the `watch_all.scr` file it created. Copy the `watch ...` line
   (and the `vcd_start trace.vcd` line) into whatever script file you
   normally give actsim, before the `cycle`/`run`/`exit` lines.
4. Run your simulation the normal way. It will now also produce a
   `trace.vcd` file.
5. Open VisualAct, go to the Replay tab, and load that `trace.vcd`.

Because `hier_dump` works out the channel names for you, you don't need to
type them by hand. Just make sure you use the same design/top/focus-path
both when you run `hier_dump` and when you load the hierarchy in VisualAct,
so everything matches.

## Build

You need `ACT_HOME` set to your ACT install folder.

```
cd hier_dump
make
```

## Run

```
cd server
pip install flask   # only needed once
ACT_HOME=<path-to-your-ACT-install> python3 app.py
```

Then open http://localhost:5055 in a browser.

**Floorplan tab**: type in the design file and top process (same as you'd
give actsim), and a focus path if you need one. Click "📥 Load hierarchy."
Drag boxes to arrange them, or click "📐 Auto-arrange" to lay them out for
you. You can click and drag on empty space to select several boxes at once
(hold Cmd, Ctrl, or Shift to add or remove one box from the selection).
Drag a corner to resize a box — every box of the same type resizes with it.
Double-click a name to turn it sideways, useful for narrow boxes. Click
"💾 Save floorplan" to keep your layout for next time.

**Replay tab**: either click "▶️ Run simulation" (works for simple designs
you can run with a plain `actsim` command), or type in the path to a
`trace.vcd` you already made and click "📂 Load trace." Then use play,
pause, and the slider to move through the simulation. "Activity window %"
controls how sensitive the coloring is — a real transaction on a channel
only lasts an instant, so without some window around the current time,
you'd almost never catch one. Click one or more modules (Cmd/Ctrl/Shift-
click for more than one) and click "📊 Channel status" to open a side panel
listing every channel of the selected module(s) and whether each one is
currently **pending** (waiting on its handshake partner) or has **just
completed** a transfer — it updates live as you play or scrub.

**Search**: the 🔍 box (top right, next to the tabs) highlights every
module whose name contains what you type, in whichever tab is open. Click
"➕ Add search matches" to add all of the currently highlighted modules to
the Replay tab's selection and open the channel status panel for them.

## Main features

- Shows the full hierarchy of a design, with arrays like `PE[i][j]` shown
  as individual boxes, correctly wired
- Drag and resize boxes; select several at once (click, or Cmd/Ctrl/Shift-
  click for more); boxes of the same type resize together; auto-arrange
  lays out arrays as a real grid
- Save and reload your layout
- Search for a module by name and highlight every match
- Play back a simulation with colors showing real activity, at any speed
- A side panel listing the exact channel-by-channel status (pending / just
  completed) of any selected module(s), live during playback
- Light and dark theme

## Example

Say your design lives in `chip.act`, and you normally simulate it with:

```
actsim chip.act top
```

Suppose `top` is a small testbench that instantiates the real design under
test as a sub-instance called `dut`. To look at `dut` itself instead of the
testbench wrapper:

```
hier_dump chip.act top /tmp/chip_hier TB.dut
```

(replace `TB.dut` with whatever the actual dotted path to your design is —
leave it off entirely if `top` *is* the design you want to look at).

Open the `watch_all.scr` this creates, copy its `watch ...` and
`vcd_start trace.vcd` lines into whatever script file you normally pipe
into actsim, and run your simulation as usual — it will now also produce
`trace.vcd`. In VisualAct: Design = `chip.act`, Top process = `top`, Focus
instance path = `TB.dut`. Load the hierarchy, save a floorplan, then load
`trace.vcd` in the Replay tab.

## Things to know

- This is playback of a finished simulation, not a live view of one that's
  still running.
- The colors are based on a time window, not the exact instant, because a
  real transaction is too short to catch otherwise (see Replay tab above).
- Very narrow channels (under 3 bits) can't show "waiting," only "idle" or
  "active."
- `hier_dump` creates its output folder for you if it doesn't exist yet.
