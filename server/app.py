"""Backend for the actsim process/channel profiler.

Two-step workflow served here:
  1. GET  /api/hierarchy   -> runs hier_dump, returns instance/channel graph
     GET/POST /api/floorplan -> load/save the user's dragged layout
  2. POST /api/run         -> runs `actsim <design> <top> < watch_all.scr`
     GET  /api/trace       -> parses the resulting trace.vcd into per-channel timelines

Standalone: does not modify anything under actflow/. Requires `hier_dump` to be
built (see ../hier_dump/) and `actsim` to be on PATH (it already is once
actflow_build/bin is on PATH, as it is in the dev environment this was built in).
"""
import hashlib
import json
import os
import subprocess

from flask import Flask, jsonify, request, send_from_directory

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WEB_DIR = os.path.join(ROOT, "web")
RUNS_DIR = os.environ.get("VISUALACT_RUNS", os.path.join(ROOT, "runs"))
HIER_DUMP_BIN = os.environ.get(
    "HIER_DUMP_BIN", os.path.join(ROOT, "hier_dump", "hier_dump")
)

from vcd_parse import parse_vcd

app = Flask(__name__, static_folder=None)


def _outdir(design, top, prefix=""):
    # prefix is folded into the key so a run's watch_all.scr/hierarchy.json
    # (whose channel names depend on it) never gets confused with another
    # prefix's for the same design+top.
    design = os.path.abspath(os.path.expanduser(design))
    key = hashlib.sha1(f"{design}::{top}::{prefix}".encode()).hexdigest()[:16]
    d = os.path.join(RUNS_DIR, key)
    os.makedirs(d, exist_ok=True)
    return design, d


def _require(args, name):
    v = args.get(name)
    if not v:
        raise ValueError(f"missing required query param '{name}'")
    return v


@app.errorhandler(ValueError)
def _handle_value_error(e):
    return jsonify({"error": str(e)}), 400


@app.route("/api/hierarchy")
def api_hierarchy():
    design = _require(request.args, "design")
    top = _require(request.args, "top")
    prefix = request.args.get("prefix", "")
    force = request.args.get("force") == "1"
    design_abs, outdir = _outdir(design, top, prefix)

    hier_path = os.path.join(outdir, "hierarchy.json")
    stale = os.path.exists(hier_path) and os.path.exists(HIER_DUMP_BIN) and (
        os.path.getmtime(HIER_DUMP_BIN) > os.path.getmtime(hier_path)
    )
    if force or stale or not os.path.exists(hier_path):
        if not os.path.exists(HIER_DUMP_BIN):
            return jsonify({"error": f"hier_dump binary not found at {HIER_DUMP_BIN}"}), 500
        args = [HIER_DUMP_BIN, design_abs, top, outdir]
        if prefix:
            args.append(prefix)
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            # relative `import "..."` in the .act file resolve against cwd
            cwd=os.path.dirname(design_abs),
        )
        if result.returncode != 0:
            return (
                jsonify(
                    {
                        "error": "hier_dump failed",
                        "stdout": result.stdout,
                        "stderr": result.stderr,
                    }
                ),
                500,
            )

    with open(hier_path) as f:
        return jsonify(json.load(f))


@app.route("/api/floorplan", methods=["GET", "POST"])
def api_floorplan():
    design = _require(request.args, "design")
    top = _require(request.args, "top")
    prefix = request.args.get("prefix", "")
    _, outdir = _outdir(design, top, prefix)
    path = os.path.join(outdir, "floorplan.json")

    if request.method == "POST":
        data = request.get_json(force=True, silent=False)
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
        return jsonify({"ok": True})

    if not os.path.exists(path):
        return jsonify({})
    with open(path) as f:
        return jsonify(json.load(f))


@app.route("/api/run", methods=["POST"])
def api_run():
    body = request.get_json(force=True, silent=True) or {}
    design = body.get("design") or _require(request.args, "design")
    top = body.get("top") or _require(request.args, "top")
    prefix = body.get("prefix") or request.args.get("prefix", "")
    design_abs, outdir = _outdir(design, top, prefix)

    scr_path = os.path.join(outdir, "watch_all.scr")
    if not os.path.exists(scr_path):
        return (
            jsonify({"error": f"{scr_path} not found -- run /api/hierarchy first"}),
            400,
        )

    with open(scr_path) as f:
        script = f.read()
    # vcd_start's filename is written relative to actsim's cwd, which has to
    # be the design's own directory for `import "..."` to resolve -- so
    # point it at an absolute path into our run dir instead of letting it
    # land next to the design source.
    vcd_path = os.path.join(outdir, "trace.vcd")
    script = script.replace("vcd_start trace.vcd", f"vcd_start {vcd_path}")

    result = subprocess.run(
        ["actsim", design_abs, top],
        input=script,
        capture_output=True,
        text=True,
        cwd=os.path.dirname(design_abs),
    )

    return jsonify(
        {
            "ok": result.returncode == 0 and os.path.exists(vcd_path),
            "returncode": result.returncode,
            "stdout": result.stdout[-4000:],
            "stderr": result.stderr[-4000:],
            "vcd": vcd_path if os.path.exists(vcd_path) else None,
        }
    )


@app.route("/api/trace")
def api_trace():
    # `vcd` lets you point at a trace produced outside this tool's own
    # /api/run -- e.g. a Makefile-driven project (like SPACE) that stages its
    # own watch script and writes trace.vcd into its own build/testcache dir.
    override = request.args.get("vcd")
    if override:
        vcd_path = os.path.abspath(os.path.expanduser(override))
    else:
        design = _require(request.args, "design")
        top = _require(request.args, "top")
        prefix = request.args.get("prefix", "")
        _, outdir = _outdir(design, top, prefix)
        vcd_path = os.path.join(outdir, "trace.vcd")

    if not os.path.exists(vcd_path):
        return jsonify({"error": f"{vcd_path} not found -- run the simulation first"}), 400
    return jsonify(parse_vcd(vcd_path))


@app.route("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(WEB_DIR, filename)


if __name__ == "__main__":
    os.makedirs(RUNS_DIR, exist_ok=True)
    app.run(debug=True, port=5055)
