"""Parse a VCD file produced by actsim's `vcd_start` into per-channel state timelines.

actsim's tracelib (actflow/actsim/tracelib/vcd.cc) encodes each watched channel as a
`b<bits> <id>` value-change line:
  - "bz"          -> idle (ACT_CHAN_IDLE)
  - "bz01"        -> recv-blocked (ACT_CHAN_RECV_BLOCKED), only for width >= 3
  - "bz10"        -> send-blocked (ACT_CHAN_SEND_BLOCKED), only for width >= 3
  - real bits, e.g. "b101" -> active transfer (ACT_CHAN_VALUE)
The $var line's signal name is exactly the dotted name passed to `watch`, so no
name reconciliation against hierarchy.json is needed.
"""
import re

_VAR_RE = re.compile(r"^\$var\s+\S+\s+\d+\s+(\S+)\s+(\S+)\s*\$end\s*$")
_CHANGE_RE = re.compile(r"^b([01xzXZ]+)\s+(\S+)\s*$")


def _classify(bits):
    if "z" in bits or "Z" in bits:
        if bits in ("z01",):
            return "blocked"
        if bits in ("z10",):
            return "blocked"
        return "idle"
    return "active"


def parse_vcd(path):
    """Returns {"end_time": int, "channels": {name: [{"t": int, "state": str}, ...]}}"""
    id_to_name = {}
    timelines = {}
    cur_time = 0
    end_time = 0
    in_defs = True

    with open(path, "r", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            if in_defs:
                if line.startswith("$var"):
                    m = _VAR_RE.match(line)
                    if m:
                        ident, name = m.group(1), m.group(2)
                        id_to_name[ident] = name
                        timelines.setdefault(name, [])
                    continue
                if line.startswith("$enddefinitions"):
                    in_defs = False
                continue

            if line.startswith("#"):
                try:
                    cur_time = int(line[1:])
                except ValueError:
                    continue
                end_time = max(end_time, cur_time)
                continue

            if line.startswith("b") or line.startswith("B"):
                m = _CHANGE_RE.match(line)
                if not m:
                    continue
                bits, ident = m.group(1), m.group(2)
                name = id_to_name.get(ident)
                if name is None:
                    continue
                state = _classify(bits)
                tl = timelines[name]
                if tl and tl[-1]["state"] == state:
                    continue
                tl.append({"t": cur_time, "state": state})
                continue
            # scalar 0/1/x/z changes (single-char values, no leading 'b') are
            # ignored here since watched channels are always emitted as buses.

    return {"end_time": end_time, "channels": timelines}


if __name__ == "__main__":
    import sys
    import json

    print(json.dumps(parse_vcd(sys.argv[1]), indent=2))
