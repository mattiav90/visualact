/*
 * hier_dump: standalone tool (not part of ACT core) that dumps a process's
 * direct sub-instances and the channels connecting them (or connecting them
 * to the design boundary) as JSON, plus a ready-to-run actsim watch-script
 * for those channels.
 *
 * Usage: hier_dump <design.act> <SimulatedTopProcess> <outdir> [focus-path]
 *
 * <design.act> and <SimulatedTopProcess> must be EXACTLY what you'd pass to
 * `actsim <design.act> <SimulatedTopProcess>` for the real simulation --
 * i.e. the actual root of the design as far as actsim is concerned, however
 * uninteresting a wrapper it is. <focus-path> is a dotted instance path
 * (e.g. `TB.space`, matching what you'd type after `watch` at the actsim
 * prompt) from that real top down to whichever sub-instance's own hierarchy
 * you actually want dumped -- e.g. if `top` instantiates `test TB;` and
 * `test` instantiates `SPACE space;`, then `-focus-path TB.space` dumps
 * SPACE's direct sub-instances/channels, and every channel name written to
 * hierarchy.json/watch_all.scr is automatically prefixed with `TB.space.` so
 * it's directly watchable from the real simulated top -- no separate,
 * manually-kept-in-sync "watch prefix" to get wrong.
 *
 * Two kinds of channel endpoint are unified through the same mechanism:
 *   - a locally-declared named channel variable in a process's scope
 *     (e.g. `chan(T) C;`), and
 *   - a sub-instance's channel-typed port (e.g. `space.DATA_IN`, reached
 *     without any local channel variable, e.g. `a.O = b.I;`).
 * Both resolve to the same union-find `act_connection*` via
 * `ActId::Canonical()`, so grouping every endpoint by its canonical pointer
 * gives the real channel graph regardless of which style the design uses.
 *
 * Array instances (e.g. `Processing_Element PE[8][8];`) are expanded into
 * one entry per element ("PE[0][0]", "PE[0][1]", ...), and array-typed
 * ports (e.g. `chan!(T) OUT[64];`, wired per-index like
 * `Weight_Interface.OUT[i] = PE[..].IN;`) are likewise expanded per index
 * before connection resolution -- otherwise those per-index connections are
 * invisible (the whole port/instance has no single canonical connection).
 */
#include <act/act.h>
#include <act/act_array.h>
#include <act/iter.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <errno.h>
#include <map>
#include <string>
#include <vector>

// mkdir -p equivalent: create outdir (and any missing parent directories)
// so callers never have to remember to do it themselves first.
static bool ensureDir(const std::string &path) {
  if (path.empty()) return true;
  struct stat st;
  if (stat(path.c_str(), &st) == 0) return S_ISDIR(st.st_mode);

  size_t slash = path.find_last_of('/');
  if (slash != std::string::npos && slash > 0) {
    if (!ensureDir(path.substr(0, slash))) return false;
  }
  if (mkdir(path.c_str(), 0755) != 0 && errno != EEXIST) return false;
  return true;
}

struct Endpoint {
  std::string instance;  // empty = design boundary (top-level port/local var)
  std::string port;      // port name (with any array suffix), or the local
                          // channel variable's name (with any array suffix)
  Type::direction dir;
};

static std::string jesc(const std::string &s) {
  std::string out;
  for (char c : s) {
    if (c == '"' || c == '\\') out += '\\';
    out += c;
  }
  return out;
}

static std::string dottedName(const Endpoint &e) {
  if (e.instance.empty()) return e.port;
  return e.instance + "." + e.port;
}

// "" for a scalar (non-array) type, else every element's bracket suffix,
// e.g. {"[0][0]", "[0][1]", ..., "[7][7]"} for an 8x8 array.
static std::vector<std::string> arraySuffixes(Array *arr) {
  std::vector<std::string> out;
  if (!arr) {
    out.push_back("");
    return out;
  }
  Arraystep *as = arr->stepper();
  do {
    char *s = as->string();
    out.push_back(s ? s : "");
    as->step();
  } while (!as->isend());
  delete as;
  return out;
}

// ActId::parseId() takes a mutable buffer.
static ActId *parseIdMutable(const std::string &s) {
  std::vector<char> buf(s.begin(), s.end());
  buf.push_back('\0');
  return ActId::parseId(buf.data());
}

static std::string stripArrayBrackets(const std::string &s) {
  size_t pos = s.find('[');
  return pos == std::string::npos ? s : s.substr(0, pos);
}

static std::vector<std::string> splitDotted(const std::string &s) {
  std::vector<std::string> parts;
  size_t start = 0;
  for (size_t i = 0; i <= s.size(); i++) {
    if (i == s.size() || s[i] == '.') {
      if (i > start) parts.push_back(s.substr(start, i - start));
      start = i + 1;
    }
  }
  return parts;
}

int main(int argc, char **argv) {
  if (argc != 4 && argc != 5) {
    fprintf(stderr, "Usage: %s <design.act> <SimulatedTopProcess> <outdir> [focus-path]\n",
            argv[0]);
    return 1;
  }
  const char *design = argv[1];
  const char *topname = argv[2];
  const char *outdir = argv[3];
  std::string focusPath = (argc == 5) ? argv[4] : "";

  Act a(design);
  a.Expand();

  Process *p = a.findProcess(topname, true);
  if (!p) {
    fprintf(stderr, "Could not find process `%s' in `%s'\n", topname, design);
    return 1;
  }
  if (!p->isExpanded()) {
    p = p->Expand(ActNamespace::Global(), p->CurScope(), 0, NULL);
  }
  if (!p || !p->isExpanded()) {
    fprintf(stderr, "Process `%s' could not be expanded\n", topname);
    return 1;
  }

  // Walk down the focus path from the real simulated top to find the
  // process whose own hierarchy we're actually dumping.
  Scope *top = p->CurScope();
  std::string resolvedProcessName = topname;

  for (auto &comp : splitDotted(focusPath)) {
    std::string baseName = stripArrayBrackets(comp);
    ValueIdx *found = nullptr;
    ActInstiter walkIt(top);
    for (walkIt = walkIt.begin(); walkIt != walkIt.end(); walkIt++) {
      ValueIdx *vx = *walkIt;
      if (strcmp(vx->getName(), baseName.c_str()) == 0) {
        found = vx;
        break;
      }
    }
    if (!found) {
      fprintf(stderr, "focus-path `%s': no instance named `%s'\n",
              focusPath.c_str(), baseName.c_str());
      return 1;
    }
    if (!TypeFactory::isProcessType(found->t)) {
      fprintf(stderr, "focus-path `%s': `%s' is not a process instance\n",
              focusPath.c_str(), baseName.c_str());
      return 1;
    }
    Process *childProc = dynamic_cast<Process *>(found->t->BaseType());
    if (!childProc || !childProc->isExpanded()) {
      fprintf(stderr, "focus-path `%s': `%s' did not resolve to an expanded process\n",
              focusPath.c_str(), baseName.c_str());
      return 1;
    }
    top = childProc->CurScope();
    resolvedProcessName = childProc->getName();
  }

  struct Inst {
    std::string name;
    std::string type;
  };
  std::vector<Inst> instances;

  // canonical connection pointer -> every endpoint that resolves to it
  std::map<act_connection *, std::vector<Endpoint>> groups;

  auto addEndpoint = [&](const std::string &fullId, const std::string &instName,
                          const std::string &portName, Type::direction dir) {
    ActId *id = parseIdMutable(fullId);
    if (!id) return;
    act_connection *c = id->Canonical(top, true);
    if (!c) return;
    groups[c].push_back(Endpoint{instName, portName, dir});
  };

  ActInstiter it(top);
  for (it = it.begin(); it != it.end(); it++) {
    ValueIdx *vx = *it;
    if (TypeFactory::isParamType(vx->t)) continue;
    if (strcmp(vx->getName(), "self") == 0) continue;

    if (TypeFactory::isProcessType(vx->t)) {
      UserDef *ud = dynamic_cast<UserDef *>(vx->t->BaseType());
      std::string baseName = vx->getName();
      std::vector<std::string> instSuffixes = arraySuffixes(vx->t->arrayInfo());

      for (auto &isuf : instSuffixes) {
        instances.push_back(Inst{baseName + isuf, ud ? ud->getName() : "?"});
      }
      if (!ud) continue;

      for (int i = 0; i < ud->getNumPorts(); i++) {
        InstType *pt = ud->getPortType(i);
        if (!TypeFactory::isChanType(pt)) continue;
        std::string portName = ud->getPortName(i);
        std::vector<std::string> portSuffixes = arraySuffixes(pt->arrayInfo());

        for (auto &isuf : instSuffixes) {
          std::string instName = baseName + isuf;
          for (auto &psuf : portSuffixes) {
            std::string port = portName + psuf;
            addEndpoint(instName + "." + port, instName, port, pt->getDir());
          }
        }
      }
    } else if (TypeFactory::isChanType(vx->t)) {
      // locally-declared channel variable (or the top process's own
      // boundary port, which also shows up here) -- record it with no
      // instance qualifier.
      std::string baseName = vx->getName();
      std::vector<std::string> suffixes = arraySuffixes(vx->t->arrayInfo());
      for (auto &suf : suffixes) {
        std::string name = baseName + suf;
        addEndpoint(name, "", name, vx->t->getDir());
      }
    }
  }

  struct Chan {
    std::string name, from, to;
  };
  std::vector<Chan> channels;

  for (auto &kv : groups) {
    std::vector<Endpoint> &eps = kv.second;
    if (eps.size() < 2) continue;  // unconnected port, nothing to draw

    // prefer a bare local-channel name for the watch-name if one exists,
    // else fall back to the first endpoint's dotted instance.port name.
    const Endpoint *nameSrc = &eps[0];
    for (auto &e : eps) {
      if (e.instance.empty()) {
        nameSrc = &e;
        break;
      }
    }

    const Endpoint *from = nullptr, *to = nullptr;
    for (auto &e : eps) {
      if (e.dir == Type::OUT && !from) from = &e;
      if (e.dir == Type::IN && !to) to = &e;
    }
    if (!from) from = &eps[0];
    if (!to) to = (eps.size() > 1 ? &eps[1] : &eps[0]);

    std::string watchName =
        focusPath.empty() ? dottedName(*nameSrc) : focusPath + "." + dottedName(*nameSrc);
    channels.push_back(Chan{watchName, from->instance, to->instance});
  }

  if (!ensureDir(outdir)) {
    fprintf(stderr, "Could not create output directory `%s': %s\n", outdir, strerror(errno));
    return 1;
  }

  std::string hierPath = std::string(outdir) + "/hierarchy.json";
  std::string scrPath = std::string(outdir) + "/watch_all.scr";

  FILE *hf = fopen(hierPath.c_str(), "w");
  if (!hf) {
    fprintf(stderr, "Could not open `%s' for writing\n", hierPath.c_str());
    return 1;
  }
  fprintf(hf, "{\n  \"process\": \"%s\",\n  \"instances\": [\n",
          jesc(resolvedProcessName).c_str());
  for (size_t i = 0; i < instances.size(); i++) {
    fprintf(hf, "    {\"name\": \"%s\", \"type\": \"%s\"}%s\n",
            jesc(instances[i].name).c_str(), jesc(instances[i].type).c_str(),
            i + 1 < instances.size() ? "," : "");
  }
  fprintf(hf, "  ],\n  \"channels\": [\n");
  for (size_t i = 0; i < channels.size(); i++) {
    auto &c = channels[i];
    fprintf(hf, "    {\"name\": \"%s\", \"from\": %s, \"to\": %s}%s\n",
            jesc(c.name).c_str(),
            c.from.empty() ? "null" : ("\"" + jesc(c.from) + "\"").c_str(),
            c.to.empty() ? "null" : ("\"" + jesc(c.to) + "\"").c_str(),
            i + 1 < channels.size() ? "," : "");
  }
  fprintf(hf, "  ]\n}\n");
  fclose(hf);

  FILE *sf = fopen(scrPath.c_str(), "w");
  if (!sf) {
    fprintf(stderr, "Could not open `%s' for writing\n", scrPath.c_str());
    return 1;
  }
  // actsim's command-line reader (act/miniscm/lispCli.c) reads each line
  // into a fixed 10240-byte buffer; a single `watch` line longer than that
  // gets silently split mid-token on a subsequent read, corrupting the
  // parse and dropping every channel after the break point with no error
  // pointing back at `watch` itself (just a stray "Unknown command name"
  // for whatever fragment follows). Designs with enough channels blow well
  // past 10240 bytes on one line, so split into multiple `watch` lines,
  // each kept safely under the limit.
  const size_t kMaxWatchLineLen = 8000;
  if (!channels.empty()) {
    std::string line = "watch";
    for (auto &c : channels) {
      if (line.size() + 1 + c.name.size() > kMaxWatchLineLen) {
        fprintf(sf, "%s\n", line.c_str());
        line = "watch";
      }
      line += " ";
      line += c.name;
    }
    fprintf(sf, "%s\n", line.c_str());
  }
  fprintf(sf, "vcd_start trace.vcd\n");
  fprintf(sf, "cycle\n");
  fprintf(sf, "exit\n");
  fclose(sf);

  fprintf(stderr, "wrote %s (process `%s': %zu instances, %zu channels) and %s\n",
          hierPath.c_str(), resolvedProcessName.c_str(), instances.size(),
          channels.size(), scrPath.c_str());
  return 0;
}
