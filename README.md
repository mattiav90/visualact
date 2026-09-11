# VisualAct

VisualAct is a tool for looking at ACT designs that you simulate with
`actsim`. It has two parts:

1. **Floorplan** — shows the modules in your design and how they connect,
   as boxes and lines you can drag around. You can click on any module and
   open it up to see the modules inside it.
2. **Replay** — plays back a finished simulation and colors each module
   green when it's doing work, yellow when it's waiting, and white when
   it's idle.

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
give actsim), and a focus path if you need one. Click "Load hierarchy."
Drag boxes to arrange them. You can click and drag on empty space to select
several boxes at once (hold shift to add or remove one box from the
selection). Drag a corner to resize a box — every box of the same type
resizes with it. Double-click a name to turn it sideways, useful for narrow
boxes. Select one or more boxes and click "Expand selected" to see what's
inside them, or "Collapse selected" to close them back up. Click "Save
floorplan" to keep your layout for next time.

**Replay tab**: either click "Run simulation" (works for simple designs you
can run with a plain `actsim` command), or type in the path to a
`trace.vcd` you already made and click "Load trace." Then use play, pause,
and the slider to move through the simulation. "Activity window %" controls
how sensitive the coloring is — a real transaction on a channel only lasts
an instant, so without some window around the current time, you'd almost
never catch one.

## Main features

- Shows the full hierarchy of a design, with arrays like `PE[i][j]` shown
  as individual boxes, correctly wired
- Drag and resize boxes; select several at once; boxes of the same type
  resize together; auto-arrange lays out arrays as a real grid
- Open up any box to see what's inside it, as many levels deep as you want
- Save and reload your layout, including what you had expanded
- Play back a simulation with colors showing real activity, at any speed
- Light and dark theme

## Example: SPACE

SPACE (`~/Yale/project/SPACE`) is run with `make v test0` (or `test0M`),
which actually runs `actsim top.act top < act_ref0.scr`. `top` contains
`TB`, which contains `space` (the actual accelerator). To look at the
accelerator itself:

```
hier_dump top.act top /tmp/space_hier TB.space
```

The `watch` line this makes is already placed inside
`scripts/simulation/actsim_files/act_ref0.scr`. So running `make v test0`
already makes a trace file at
`test/testcache/generic/SPACE/trace.vcd`. In VisualAct: Design = `top.act`,
Top process = `top`, Focus instance path = `TB.space`. Load the hierarchy,
save a floorplan, then load that trace file in the Replay tab.

## Things to know

- This is playback of a finished simulation, not a live view of one that's
  still running.
- The colors are based on a time window, not the exact instant, because a
  real transaction is too short to catch otherwise (see Replay tab above).
- Very narrow channels (under 3 bits) can't show "waiting," only "idle" or
  "active."
- If a box you opened up has a big 1-D array inside it, it may lay out as
  one long row instead of a grid. You can drag things around by hand.
- If you make a box smaller than what's inside it, the inside boxes will
  stick out instead of being hidden.
