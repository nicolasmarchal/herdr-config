// Workspace sidebar: folders and their spaces.
//
// A folder is a directory on disk: a git repo (all its checkouts) or, outside
// git, the directory a space is in. A space is one checkout of it: the repo's
// main checkout, or a worktree on its own branch. Folders come from the spaces
// themselves (where each space's first terminal is now), in the order of their
// first space; inside one, the main checkout comes first, then the worktrees.
// Rows read by branch; the folder row carries the repo's name.
//
// - "Add folder" (header) picks a directory and opens it as a space (or goes to
//   the folder when it's already here).
// - A folder's + makes a new branch in a new worktree (the shipped worktree
//   dialog) and opens it as a space; outside git, a new space in the directory.
// - Click a folder for its overview (mods/folder-overview, the layout's
//   "work-stack"), its chevron folds it, right-click for its menu
//   (mods/folder-spaces-menu), drag it to reorder folders.
// - Click a space to go there, right-click for its menu, drag to reorder it
//   within its folder.
//
// Shared state: "space.groups" = { [folder key]: { name?, collapsed? } } (the
// person's names and folds); "folder.groups" = { [key]: { name, dir, machine, git,
// spaces } } published for the overview and the menu. A folder key is
// JSON [machine, repo's git dir] for a repo, JSON [machine, directory] otherwise.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout, pickFolder, home } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
// `seen`: space -> its last live folder. While switching spaces a terminal's cwd
// can be missing for a moment; falling back to where the space was made would
// make it jump folders and lose its branch, so the last live folder holds.
function place(s, ps, seen) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  const live = ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd;
  if (live) { if (seen) seen[s.id] = live; return live; }
  return seen?.[s.id] || s.folder;
}
const RAIL_CELL = 32;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps, seen) => JSON.stringify([s.machine ?? null, place(s, ps, seen)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
const dirName = (dir, on) => (!dir ? "?" : !on && dir.replace(/\/+$/, "") === home().replace(/\/+$/, "") ? "~" : base(dir));
const tilde = (dir, on) => (!on && dir?.startsWith(home()) ? `~${dir.slice(home().length)}` : dir ?? "");
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

const GROUPS = "space.groups"; // the person's folder names and folds
const PUBLISHED = "folder.groups"; // what the overview and menu read
const overviewOpen = () => find(layout(), "work-stack")?.active === "overview";
// Picking a space leaves a folder's overview page for the tab.
function leaveOverview() {
  if (overviewOpen()) run("layout.select", { stack: "work-stack", child: "work" });
}
function prefs() {
  const raw = shared(GROUPS);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}
function setPref(key, patch) {
  const all = prefs();
  setShared(GROUPS, { ...all, [key]: { ...(all[key] ?? {}), ...patch } });
}
// The most urgent agent status among `rows`: blocked > done > working.
function urgent(rows) {
  for (const st of ["blocked", "done", "working"]) if (rows.some((r) => r.w.status === st)) return st;
  return null;
}
const menu = (props, size) => openOverlay({ mod: "folder-spaces-menu", kind: "popup", width: 250, height: size, props });

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, main, branch, ahead, behind, changed, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.seen = {}; // space -> its last live folder (see place)
    this.lastGit = {}; // space -> its git at the last draw, while its place is looked at again
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears in its folder instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null; // a space being dragged
    this.over = null;
    this.pressedGroup = null; // a folder being dragged
    this.overGroup = null;
    this.keyOf = {}; // space -> its folder's key, as drawn
    this.groupList = []; // the folders as drawn, every machine
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // Refresh only when the refs could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps, this.seen);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        await Promise.all(keys.map((key) => this.check(key, cx)));
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, uncommitted changes, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // Two reads: a folder name may itself contain a newline.
      const [r, common] = await Promise.all([
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
      ]);
      if (r.code !== 0 || common.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.code !== 0 ? r.stderr : common.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = r.stdout.replace(/\n$/, ""), repo = common.stdout.replace(/\n$/, "");
      const [branch, counts, status] = await Promise.all([
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
        exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=normal"], { cwd, on, timeout: 10000 }).catch(() => null),
      ]);
      const main = repo.endsWith("/.git") ? repo.slice(0, -5) : top;
      const name = repo.endsWith("/.git") ? base(main) : base(repo).replace(/\.git$/, "");
      const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      const changed = status?.code === 0 ? status.stdout.split("\n").filter(Boolean).length : 0;
      const info = { name, main, top, branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : "(detached)", ahead, behind, changed, repo: JSON.stringify([on, repo]), linked: repo !== `${top}/.git` };
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Moves spaces so Herdr's order is `target` (space ids). Simulates the batch so
  // later indexes include earlier moves. An attempted write can lose a sync
  // conflict: allow the echo to settle before retrying.
  reorder(target) {
    const order = spaces().map(w => w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      const byId = Object.fromEntries(spaces().map((w) => [w.id, w]));
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < target.length; i++) {
        const from = order.indexOf(target[i]);
        if (from === i || from === -1) continue;
        run("space.move", { id: target[i], index: i + 1 });
        moved.add(byId[target[i]]?.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
  }

  // Spaces in folder order: folders by their first space, and in each the main
  // checkout first, then its worktrees. Each row: { w, i, g, key, tree }.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps, this.seen) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const byKey = new Map();
    sp.forEach((w, i) => {
      const k = where(w, ps, this.seen);
      // A place not looked at yet (a cd) keeps the space's last git until it is.
      const g = (k in this.git ? this.git[k] : this.lastGit[w.id]) ?? null;
      this.lastGit[w.id] = g;
      const key = g ? g.repo : k;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ w, i, g, key, tree: Boolean(g?.linked) });
    });
    const out = [...byKey.values()].flatMap((rows) => [...rows.filter((r) => !r.tree), ...rows.filter((r) => r.tree)]);
    this.reorder(out.map((r) => r.w.id));
    return out.filter(r => this.shown.has(r.w.id));
  }

  // Consecutive rows of one key, as folders: { key, rows, g, machine, dir, name, alias }.
  groups(rows) {
    const p = prefs(), out = [];
    for (const r of rows) {
      const last = out[out.length - 1];
      if (last?.key === r.key) { last.rows.push(r); continue; }
      out.push({ key: r.key, rows: [r] });
    }
    for (const f of out) {
      f.g = f.rows.find((r) => r.g)?.g ?? null;
      f.machine = f.rows[0].w.machine ?? null;
      f.dir = f.g ? f.g.main : JSON.parse(f.key)[1];
      f.alias = typeof p[f.key]?.name === "string" && p[f.key].name.trim() ? p[f.key].name.trim() : null;
      f.name = f.alias ?? (f.g ? f.g.name : dirName(f.dir, f.machine));
      f.collapsed = !!p[f.key]?.collapsed;
    }
    return out;
  }

  // Moves folder `from` before or after folder `to` (same machine), with all its spaces.
  moveGroup(from, to) {
    const list = this.groupList;
    const a = list.findIndex((f) => f.key === from), b = list.findIndex((f) => f.key === to);
    if (a < 0 || b < 0 || a === b || list[a].machine !== list[b].machine) return;
    const next = list.filter((f) => f.key !== from);
    next.splice(next.findIndex((f) => f.key === to) + (a < b ? 1 : 0), 0, list[a]);
    const shownIds = next.flatMap((f) => f.rows.map((r) => r.w.id));
    // Spaces not drawn yet keep their place at the end.
    const rest = spaces().map((w) => w.id).filter((id) => !shownIds.includes(id));
    this.reorder([...shownIds, ...rest]);
  }

  // New space in a folder: a new branch in a new worktree, or a plain space there.
  addTo(f) {
    if (f.g) openOverlay({ mod: "issue-worktree", kind: "dialog", width: 580, height: 500, props: { folder: f.dir, machine: f.machine, action: "new" } });
    else run("space.new", { folder: f.dir, machine: f.machine ?? "" });
  }

  // Header's "Add folder": a directory on this computer. One already here is gone to.
  addFolder(cx) {
    cx.spawn(async (cx) => {
      const dir = await pickFolder({ prompt: "Add folder" });
      if (!dir) return;
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir }).catch(() => null);
      const key = common?.code === 0 ? JSON.stringify([null, common.stdout.replace(/\n$/, "")]) : JSON.stringify([null, dir.replace(/\/+$/, "")]);
      const existing = this.groupList.find((f) => f.key === key);
      if (existing) {
        run("space.select", { id: existing.rows[0].w.id });
        leaveOverview();
      } else {
        // A repo opens on its main checkout, whatever folder inside it was picked.
        const top = common?.code === 0 && common.stdout.trim().endsWith("/.git") ? common.stdout.trim().slice(0, -5) : dir;
        run("space.new", { folder: top, machine: "" });
      }
      cx.notify();
    });
  }

  openOverview(f) {
    // The folder's overview page, in place of the tab (layouts with a "work-stack").
    if (!find(layout(), "work-stack")) return setPref(f.key, { collapsed: !f.collapsed });
    // Where the person was: the page leaves for the tab once they pick another one.
    const sp = spaces().find((x) => x.active);
    setShared("folder.overview.from", `${sp?.id}|${sp?.tabs?.find((x) => x.active)?.id}`);
    setShared("folder.overview", f.key);
    run("layout.select", { stack: "work-stack", child: "overview" });
  }

  folderRow(f, t) {
    const dragging = this.pressedGroup !== null && this.pressedGroup !== f.key;
    const target = dragging && this.overGroup === f.key;
    const fromIndex = this.groupList.findIndex((x) => x.key === this.pressedGroup);
    const index = this.groupList.findIndex((x) => x.key === f.key);
    const status = urgent(f.rows);
    const viewing = shared("folder.overview") === f.key && overviewOpen();
    const stop = (_e, cx) => cx.stop_propagation();
    const changed = f.rows.reduce((n, r) => n + (r.g?.changed ?? 0), 0);
    return h_flex().id(`folder-${f.key}`).relative().h(30).flex_none().px(8).gap(7).items_center().rounded(7)
      .text_size(12.5).text_color(t.foreground).cursor_pointer()
      .tooltip(tilde(f.dir, f.machine))
      .hover((s) => s.bg(t.hover))
      .when(viewing, (el) => el.bg(t.selected))
      .when(this.pressedGroup === f.key && this.overGroup !== f.key, (el) => el.opacity(0.5))
      .when(target, (el) => el.child(div().absolute().left(0).right(0).h(2).bg(t.accent)
        .when(fromIndex < index, (line) => line.bottom(0))
        .when(fromIndex > index, (line) => line.top(0))))
      .on_mouse_down("left", () => { this.pressedGroup = f.key; this.overGroup = f.key; })
      .on_mouse_down("right", () => menu({ kind: "folder", key: f.key }, 330))
      .on_mouse_move((_e, cx) => {
        if (this.pressedGroup === null || this.overGroup === f.key) return;
        const from = this.groupList.find((x) => x.key === this.pressedGroup);
        this.overGroup = from && from.machine === f.machine ? f.key : null;
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressedGroup, over = this.overGroup;
        this.pressedGroup = null;
        this.overGroup = null;
        if (from === f.key) this.openOverview(f);
        else if (from !== null && over === f.key) this.moveGroup(from, f.key);
        cx.notify();
      })
      .child(div().id(`folder-fold-${f.key}`).size(16).flex_none().flex().items_center().justify_center().rounded(4)
        .text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click((_e, cx) => { cx.stop_propagation(); setPref(f.key, { collapsed: !f.collapsed }); })
        .child(svg(`mods/workspace-chrome/chevron-${f.collapsed ? "right" : "down"}.svg`).size(11)))
      .child(svg("mods/workspace-chrome/folder.svg").size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(f.name))
      .when(f.collapsed && changed > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi3).child(`●${changed}`)))
      .when(f.collapsed, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(String(f.rows.length))))
      .when(f.collapsed && Boolean(status), (el) => el.child(div().size(7).rounded(4).flex_none().bg(tone(t, status))))
      .child(div().id(`folder-add-${f.key}`).size(20).flex_none().flex().items_center().justify_center().rounded(5)
        .tooltip(f.g ? `New branch in ${f.name} (worktree)` : `New space in ${f.name}`).text_color(t.dim)
        .hover((s) => s.bg(t.raised).text_color(t.foreground))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { cx.stop_propagation(); this.addTo(f); })
        .child(svg(`mods/workspace-chrome/${f.g ? "git-branch" : "plus"}.svg`).size(12)));
  }

  // Folders and, under each unless folded, its spaces.
  folderSections(rows, t, collapsed) {
    const list = this.groups(rows);
    if (collapsed) {
      // The rail: each folder a thin line, its spaces flat under it.
      return list.flatMap((f) => [
        railCell(h_flex().id(`folder-${f.key}`).w(RAIL_CELL).h(9).items_center().justify_center().tooltip(f.name)
          .child(div().w(16).h(1).bg(t.border))),
        ...f.rows.map((r) => this.compact(r, t)),
      ]);
    }
    return list.flatMap((f, n) => [
      ...(n > 0 ? [div().flex_none().h(6)] : []),
      this.folderRow(f, t),
      ...(f.collapsed ? [] : f.rows.map((r) => this.row(r, f, t))),
    ]);
  }

  // The folders, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const all = this.ordered();
    this.keyOf = Object.fromEntries(all.map((r) => [r.w.id, r.key]));
    this.groupList = this.groups(all);
    this.publish(all);
    return this.machineGroups(all, t, collapsed);
  }

  // What the overview and the menu need to know about each folder.
  publish(all) {
    const out = {};
    for (const f of this.groupList) out[f.key] = { name: f.name, alias: f.alias, dir: f.dir, machine: f.machine, git: Boolean(f.g), spaces: f.rows.map((r) => r.w.id) };
    // Spaces still loading keep the published folders as they were.
    if (all.length < spaces().length) return;
    if (JSON.stringify(out) !== JSON.stringify(shared(PUBLISHED) ?? null)) setShared(PUBLISHED, out);
  }

  machineGroups(rows, t, collapsed) {
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    const emptyHere = h_flex().id("folders-empty").h(28).flex_none().px(8).gap(7).items_center().rounded(7)
      .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => this.addFolder(cx))
      .child(svg("mods/workspace-chrome/folder-plus.svg").size(12)).child("Add a folder");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.length ? this.folderSections(rows, t, collapsed) : collapsed ? [] : [emptyHere];
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const login = machine?.state === "needs_login" ? `hc machine login ${m}` : null;
      const folded = this.folded.has(m);
      const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none();
      const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .when(collapsed, el => el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(login ? `${m} needs a login: run ${login}. Click for Copy.` : m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "This computer"))
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (collapsed && login) { run("app.settings", { section: "machines" }); return; }
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(!collapsed, el => el.child(icon))
        .when(collapsed, el => el.child(div().relative().flex_none().child(icon).when(Boolean(m), el => el.child(badge))))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt && !login, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); if (m) run("space.new", { machine: m }); else this.addFolder(cx); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => (m ? run("space.new", { machine: m }) : this.addFolder(cx)))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`New space on ${m ?? "this computer"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child(m ? "New space there" : "Add a folder"));
      if (!collapsed && rebuilt) return [head];
      const cell = collapsed ? railCell : (el) => el;
      const guidance = !collapsed && login ? [v_flex().px(8).pb(6).gap(3).flex_none()
        .child(div().text_size(11).text_color(t.blocked).child("needs a login: run"))
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(login).text_size(11).text_color(t.muted).child(login))
          .child(div().id(`machine-login-copy-${m}`).flex_none().px(5).py(2).rounded(4)
            .text_size(11).text_color(t.foreground).bg(t.raised).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(login); this.copiedLogin = login; cx.notify(); })
            .child(this.copiedLogin === login ? "Copied" : "Copy")))] : [];
      return [cell(head), ...guidance, ...(folded ? [] : mine.length ? this.folderSections(mine, t, collapsed) : [loading(m) ? loadingRow(m) : cell(empty)])];
    });
  }

  // After the title: the space's own name when someone named it, uncommitted
  // changes, ahead/behind, and its agents' state when it needs you.
  tail(w, g, t) {
    const extra = w.named && g && w.name !== g.branch ? w.name : "";
    const status = ["blocked", "done", "working"].includes(w.status) ? w.status : null;
    return h_flex().flex_1().min_w(0).gap(6).justify_end().items_center().text_size(11.5).text_color(t.dim)
      .when(Boolean(extra), (el) => el.child(div().min_w(0).truncate().child(extra)))
      .when(Boolean(g?.changed), (el) => el.child(div().flex_none().text_color(t.ansi3).tooltip(`${g.changed} uncommitted change${g.changed > 1 ? "s" : ""}`).child(`●${g.changed}`)))
      .when(g?.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`↑${g.ahead}`)))
      .when(g?.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`↓${g.behind}`)))
      .when(Boolean(status), (el) => el.child(div().size(7).flex_none().rounded(4).bg(tone(t, status))
        .when(status === "working", (d) => d.loop("opacity", { from: 0.35, to: 1, period: 1200 }))));
  }

  row(r, f, t) {
    const { w, i, g, tree } = r;
    // While a folder's overview is up, no space shows as the current one.
    const on = w.active && !overviewOpen();
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    const title = g ? g.branch : w.name;
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .ml(14)
      .pl(8)
      .pr(8)
      .h(28)
      .flex_none()
      .justify_center()
      .rounded(7)
      .tooltip(g ? `${tree ? "Worktree" : "Main checkout"} · ${tilde(g.top, w.machine)}` : tilde(f.dir, w.machine))
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        // Spaces move within their folder; a worktree among worktrees.
        const over = this.pressed !== null && this.keyOf[this.pressed] === r.key ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) { run("space.select", { id: w.id }); leaveOverview(); }
        cx.notify();
      })
      .on_mouse_down("right", () => menu({ kind: "space", space: w.id }, 300))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(svg(`mods/workspace-chrome/${!g ? "terminal" : tree ? "git-branch" : "git-compare"}.svg`).size(13).flex_none()
            .text_color(on ? fill : t.dim))
          .child(div().flex_shrink(0).max_w(160).truncate().text_color(on ? t.foreground : t.muted)
            .when(on, (el) => el.font_medium()).child(title))
          .child(this.tail(w, g, t)),
      );
  }

  compact({ w, i }, t) {
    return railCell(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(6)
      .justify_center()
      .items_center()
      .when(w.active && !overviewOpen(), (el) => el.bg(t.selected))
      .when(!(w.active && !overviewOpen()), (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => { run("space.select", { id: w.id }); leaveOverview(); })
      .child(div().text_color(w.active && !overviewOpen() ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  // Once: the hand-made folders of before become names of the real folders
  // their spaces are in.
  migrate() {
    const old = shared("space.folders");
    if (!Array.isArray(old)) return;
    const sp = spaces(), ps = panes(), ids = new Set(sp.map((s) => s.id));
    const waiting = old.some((f) => (f.spaces ?? []).some((id) => ids.has(id) && !(where(sp.find((s) => s.id === id), ps) in this.git)));
    if (waiting) return;
    const p = { ...prefs() };
    for (const f of old) for (const id of f.spaces ?? []) {
      const key = this.keyOf[id];
      if (key && !p[key]?.name && typeof f.name === "string") p[key] = { ...(p[key] ?? {}), name: f.name, collapsed: !!f.collapsed };
    }
    setShared(GROUPS, p);
    setShared("space.folders", null);
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    const list = this.grouped(t, collapsed);
    this.migrate();
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child("Folders"))
        .child(div().id("folder-add").size(26).flex_none().flex().items_center().justify_center().rounded(6)
          .tooltip("Add folder").hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.addFolder(cx))
          .child(svg("mods/workspace-chrome/folder-plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.over = null; this.pressedGroup = null; this.overGroup = null; cx.notify(); })
        .children(list));
  }
}
