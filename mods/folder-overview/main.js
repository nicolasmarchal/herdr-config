// A folder's page: its repo as a branch graph, in the spirit of GitKraken.
//
// Left: the repo's refs: Local branches and Remote ones (folded by "a/b" prefix),
// Worktrees (each one a space: click to go there), Stashes and Tags, with a filter.
// Right: every branch's commits (newest first, `git log --all --date-order`),
// three columns: Branch / Tag pills, the graph (lanes and merges drawn with
// paths), and the commit message. Commits not in the shown branch are dimmed.
// Click a ref to jump to its commit; click a commit for its details below.
//
// shared("folder.overview") is the sidebar's folder key, described in
// shared("folder.groups") (mods/folder-spaces). Shown in the layout's
// "work-stack" stack in place of the tab; picking a space or tab (here, in the
// sidebar or by key) goes back to the tab.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle, InputState, Input } from "gpui-base";
import { PathBuilder } from "gpui-kit";
import { spaces, panes, shared, setShared, theme, run, exec, layout, openOverlay, home, settings } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const r = find(c, id); if (r) return r; }
  return null;
}

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const US = "\x1f", RS = "\x1e";
const LIMIT = 600; // commits drawn
const ROW = 30; // a commit row's height
const LANE = 18; // a lane's width in the graph
const NODE = 18; // a commit's dot
const MAX_LANES = 14; // the graph column's widest; lanes past it are clipped
const DIFF_ROW = 20; // a diff line's height
const DIFF_MAX = 6000; // diff lines drawn
// One color per lane, strong enough on dark and light.
const LANES = ["#22a3c4", "#3b82f6", "#a855f7", "#c026d3", "#e11d48", "#ea580c", "#ca8a04", "#65a30d", "#059669", "#0891b2", "#6366f1", "#db2777"];
const laneColor = (i) => LANES[i % LANES.length];
const icon = (name) => (["tag", "cloud", "laptop", "stash", "refresh"].includes(name) ? `mods/folder-overview/${name}.svg` : `mods/workspace-chrome/${name}.svg`);

const ago = (s) => {
  const d = Date.now() / 1000 - s;
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m`;
  if (d < 86400) return `${Math.round(d / 3600)}h`;
  if (d < 86400 * 30) return `${Math.round(d / 86400)}d`;
  if (d < 86400 * 365) return `${Math.round(d / 86400 / 30)}mo`;
  return `${Math.round(d / 86400 / 365)}y`;
};
const initials = (name) => (name.match(/\b\p{L}/gu) ?? ["?"]).slice(0, 2).join("").toUpperCase();
const tilde = (dir, on) => (!on && dir?.startsWith(home()) ? `~${dir.slice(home().length)}` : dir ?? "");

// Lanes: each commit takes the lane that waits for it (or a free one), its first
// parent continues there, other parents get their own. Rows keep the lanes above
// and below them so each draws its own slice of the graph.
function lay(commits) {
  let lanes = [];
  let widest = 0;
  for (const c of commits) {
    const before = lanes.slice();
    let col = lanes.indexOf(c.sha);
    if (col < 0) { col = lanes.indexOf(null); if (col < 0) { col = lanes.length; lanes.push(null); } }
    for (let i = 0; i < lanes.length; i++) if (i !== col && lanes[i] === c.sha) lanes[i] = null;
    lanes[col] = c.parents[0] ?? null;
    const out = c.parents.length ? [col] : [];
    for (const p of c.parents.slice(1)) {
      let j = lanes.indexOf(p);
      if (j < 0) { j = lanes.indexOf(null); if (j < 0) { j = lanes.length; lanes.push(p); } else lanes[j] = p; }
      out.push(j);
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    c.col = col; c.before = before; c.after = lanes.slice(); c.out = out;
    widest = Math.max(widest, before.length, lanes.length, col + 1);
  }
  return widest;
}

// "a/b/c" names as a tree: [{ name, path, kids, item }].
function tree(items, name = (x) => x.name) {
  const root = { kids: new Map() };
  for (const it of items) {
    const parts = name(it).split("/");
    let at = root, path = "";
    parts.forEach((p, n) => {
      path = path ? `${path}/${p}` : p;
      if (!at.kids.has(p)) at.kids.set(p, { name: p, path, kids: new Map() });
      at = at.kids.get(p);
      if (n === parts.length - 1) at.item = it;
    });
  }
  const flat = (node) => [...node.kids.values()]
    .map((k) => ({ name: k.name, path: k.path, item: k.item, kids: flat(k) }))
    .sort((a, b) => (b.kids.length > 0) - (a.kids.length > 0) || a.name.localeCompare(b.name));
  return flat(root);
}

export default class FolderOverview extends View {
  init(_props, cx) {
    this.data = null; // { commits, local, remote, tags, stashes, worktrees, head, widest }
    this.error = null;
    this.selected = null; // a commit sha
    this.detail = {}; // sha -> { body, files } | null while loading
    this.fold = new Set(["section:tags", "section:stashes"]); // folded sections and ref folders
    this.filter = "";
    this.openDirs = new Set(); // ref folders opened (they start folded)
    this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Filter branches" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value().trim().toLowerCase(); cx.notify(); });
    this.refresh(cx);
    cx.timer.every(20000, (cx) => { if (this.shown()) this.refresh(cx); });
  }

  folder() {
    const key = shared("folder.overview");
    const f = (shared("folder.groups") ?? {})[key];
    return f ? { key, ...f } : null;
  }

  shown() {
    return find(layout(), "work-stack")?.active === "overview" && this.folder();
  }

  // Leave for the tab when the person picks another space or tab than the one
  // they were on when they opened the page (recorded by the sidebar's click).
  back() {
    if (find(layout(), "work-stack")?.active !== "overview") return;
    const s = spaces().find((x) => x.active), now = `${s?.id}|${s?.tabs?.find((t) => t.active)?.id}`;
    const from = shared("folder.overview.from");
    if (from && now !== from) run("layout.select", { stack: "work-stack", child: "work" });
  }

  // The branch the page is about: the space the person came from, if it's in this
  // folder, else the main checkout's.
  shownBranch(f) {
    const from = (shared("folder.overview.from") ?? "").split("|")[0];
    if (f?.spaces?.includes(from)) return spaces().find((s) => s.id === from)?.branch ?? null;
    return null;
  }

  refresh(cx, fetch = false) {
    const f = this.folder();
    if (!f?.git || this.loading) return;
    const key = f.key, on = f.machine ?? null, cwd = f.dir;
    this.loading = true;
    cx.spawn(async (cx) => {
      const git = (args, timeout) => exec("git", [...READ, ...args], { cwd, on, timeout: timeout ?? 20000 });
      try {
        if (fetch) {
          this.fetching = true; cx.notify();
          const r = await git(["fetch", "--all", "--prune"], 120000);
          this.fetching = false;
          if (r.code !== 0) this.error = r.stderr.trim() || "git fetch failed";
        }
        const [log, heads, remotes, tags, stashes, worktrees, head] = await Promise.all([
          git(["log", "--all", "--date-order", `-n${LIMIT}`, `--format=%H${US}%P${US}%an${US}%ct${US}%s${US}%D${RS}`]),
          git(["for-each-ref", `--format=%(refname:short)${US}%(objectname)${US}%(upstream:track,nobracket)${US}%(upstream:short)`, "refs/heads"]),
          git(["for-each-ref", `--format=%(refname:short)${US}%(objectname)${US}%(symref)`, "refs/remotes"]),
          git(["for-each-ref", "--sort=-creatordate", `--format=%(refname:short)${US}%(objectname)${US}%(*objectname)`, "refs/tags"]),
          git(["stash", "list", `--format=%gd${US}%s${US}%H${US}%P`]),
          git(["worktree", "list", "--porcelain"]),
          git(["symbolic-ref", "-q", "--short", "HEAD"]),
        ]);
        if (shared("folder.overview") !== key) return;
        if (log.code !== 0) {
          this.data = null;
          this.error = /does not have any commits/.test(log.stderr) ? "No commits yet" : log.stderr.trim();
          return;
        }
        const lines = (r) => (r.code === 0 ? r.stdout.split("\n").filter(Boolean).map((l) => l.split(US)) : []);
        const commits = log.stdout.split(RS).map((r) => r.replace(/^\n/, "")).filter(Boolean).map((r) => {
          const [sha, parents, author, at, subject, refs] = r.split(US);
          return { sha, parents: parents ? parents.split(" ") : [], author, at: Number(at), subject, refs: (refs ?? "").split(", ").filter(Boolean) };
        });
        const index = new Map(commits.map((c, i) => [c.sha, i]));
        // Stashes draw as their own commits beside the commit they were made on.
        const stashList = lines(stashes).map(([ref, subject, sha, parents]) => ({ name: ref, subject, sha, base: (parents ?? "").split(" ")[0] }));
        const local = lines(heads).map(([name, sha, track, upstream]) => ({
          name, sha, upstream: upstream || null,
          ahead: +(/ahead (\d+)/.exec(track ?? "")?.[1] ?? 0), behind: +(/behind (\d+)/.exec(track ?? "")?.[1] ?? 0),
        }));
        const remote = lines(remotes).filter(([name, , symref]) => !symref && !name.endsWith("/HEAD")).map(([name, sha]) => ({ name, sha }));
        const tagList = lines(tags).map(([name, sha, deref]) => ({ name, sha: deref || sha }));
        const wts = [];
        for (const block of (worktrees.code === 0 ? worktrees.stdout : "").split(/\n\n+/)) {
          const ls = block.split("\n");
          const path = ls.find((l) => l.startsWith("worktree "))?.slice(9);
          if (!path || ls.includes("bare")) continue;
          const branch = ls.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
          const sha = ls.find((l) => l.startsWith("HEAD "))?.slice(5) ?? null;
          wts.push({ path, branch, sha, main: wts.length === 0, prunable: ls.some((l) => l.startsWith("prunable")) });
        }
        const widest = lay(commits);
        this.data = { commits, index, local, remote, tags: tagList, stashes: stashList, worktrees: wts, head: head.code === 0 ? head.stdout.trim() : null, widest };
        this.error = null;
      } catch (e) {
        this.error = String(e.message ?? e);
      } finally {
        this.loading = false;
        this.fetching = false;
        cx.notify();
      }
    });
  }

  // The commits reachable from `sha` among those drawn: the shown branch.
  reach(sha) {
    const d = this.data;
    if (!d || this.reachFrom === sha) return this.reachSet;
    const set = new Set(), stack = [sha];
    while (stack.length) {
      const s = stack.pop();
      if (!s || set.has(s) || !d.index.has(s)) continue;
      set.add(s);
      stack.push(...d.commits[d.index.get(s)].parents);
    }
    this.reachFrom = sha;
    this.reachSet = set;
    return set;
  }

  jump(sha, cx) {
    const i = this.data?.index.get(sha);
    if (i === undefined) { this.note = "That commit is older than the commits shown."; cx.notify(); return; }
    this.note = null;
    this.diff = null;
    this.select(sha, cx);
    this.scroll.scroll_to_item(i, "center");
  }

  select(sha, cx) {
    this.selected = this.selected === sha ? null : sha;
    if (this.diff?.sha !== this.selected) this.diff = null;
    if (this.selected && !(sha in this.detail)) {
      const f = this.folder();
      this.detail[sha] = null;
      cx.spawn(async (cx) => {
        const r = await exec("git", [...READ, "show", "--no-color", "--name-status", `--format=%H${US}%an <%ae>${US}%cr${US}%B${RS}`, sha], { cwd: f.dir, on: f.machine ?? null }).catch(() => null);
        if (r?.code === 0) {
          const [head, files] = r.stdout.split(RS);
          const [full, author, when, body] = head.split(US);
          this.detail[sha] = {
            full, author, when, body: body.trim(),
            files: (files ?? "").split("\n").filter(Boolean).map((l) => l.split("\t")).map(([st, ...p]) => ({ st: st[0], path: p[p.length - 1], old: p.length > 1 ? p[0] : null })),
          };
        } else this.detail[sha] = { body: "", files: [], author: "", when: "", full: sha };
        cx.notify();
      });
    }
    cx.notify();
  }

  // A worktree's space: the one whose terminal is in it, else a new one there.
  openWorktree(w) {
    const f = this.folder();
    const inside = (p, dir) => p === dir || p?.startsWith(dir + "/");
    const ps = panes();
    const deeper = (this.data?.worktrees ?? []).filter((x) => x.path !== w.path && x.path.startsWith(w.path + "/"));
    const s = spaces().find((s) => (s.machine ?? null) === (f.machine ?? null) && (() => {
      const tabs = new Set(s.tabs.map((t) => t.id));
      const at = ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
      return inside(at, w.path) && !deeper.some((x) => inside(at, x.path));
    })());
    run("layout.select", { stack: "work-stack", child: "work" });
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: w.path, machine: f.machine ?? "" });
  }

  // ---- Left: refs ----

  section(id, title, glyph, count, body, t) {
    const folded = this.fold.has(`section:${id}`) && !this.filter;
    return v_flex().flex_none()
      .child(h_flex().id(`sec-${id}`).h(32).px(10).gap(8).items_center().flex_none().cursor_pointer()
        .text_size(11.5).font_semibold().text_color(t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { const k = `section:${id}`; this.fold.has(k) ? this.fold.delete(k) : this.fold.add(k); cx.notify(); })
        .child(svg(icon(`chevron-${folded ? "right" : "down"}`)).size(11).flex_none())
        .child(svg(icon(glyph)).size(13).flex_none())
        .child(div().flex_1().child(title.toUpperCase()))
        .child(div().text_color(t.accent).font_medium().child(String(count))))
      .when(!folded, (el) => el.child(v_flex().pb(6).children(body)));
  }

  refTree(prefix, nodes, depth, leaf, t) {
    return nodes.flatMap((n) => {
      if (n.kids.length && !n.item) {
        const k = `${prefix}:${n.path}`, folded = !this.openDirs.has(k) && !this.filter;
        return [
          h_flex().id(`dir-${k}`).h(26).pl(12 + depth * 14).pr(10).gap(7).items_center().flex_none().cursor_pointer()
            .text_size(12.5).text_color(t.muted).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.openDirs.has(k) ? this.openDirs.delete(k) : this.openDirs.add(k); cx.notify(); })
            .child(svg(icon(`chevron-${folded ? "right" : "down"}`)).size(10).flex_none())
            .child(svg(icon("folder")).size(13).flex_none())
            .child(div().flex_1().min_w(0).truncate().child(n.name)),
          ...(folded ? [] : this.refTree(prefix, n.kids, depth + 1, leaf, t)),
        ];
      }
      return [leaf(n.item, n.name, depth), ...(n.kids.length ? this.refTree(prefix, n.kids, depth + 1, leaf, t) : [])];
    });
  }

  refRow(id, depth, label, glyph, t, opts = {}) {
    return h_flex().id(id).h(26).pl(12 + depth * 14 + 17).pr(10).gap(7).items_center().flex_none().cursor_pointer()
      .text_size(12.5).text_color(opts.current ? t.foreground : t.muted)
      .when(Boolean(opts.current), (el) => el.bg(t.selected).font_medium())
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .when(Boolean(opts.tip), (el) => el.tooltip(opts.tip))
      .on_click((_e, cx) => opts.act?.(cx))
      .child(svg(icon(glyph)).size(13).flex_none().text_color(opts.tint ?? t.dim))
      .child(div().flex_shrink(0).max_w(190).truncate().child(label))
      .when(Boolean(opts.extra), (el) => el.child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(opts.extra)))
      .child(div().flex_1())
      .when(opts.ahead > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`${opts.ahead}↑`)))
      .when(opts.behind > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`${opts.behind}↓`)));
  }

  refsPanel(t, f) {
    const d = this.data;
    const q = this.filter;
    const match = (name) => !q || name.toLowerCase().includes(q);
    const shown = this.shownBranch(f) ?? d?.head;
    const local = (d?.local ?? []).filter((b) => match(b.name));
    const remote = (d?.remote ?? []).filter((b) => match(b.name));
    const wts = (d?.worktrees ?? []).filter((w) => match(`${w.branch ?? ""} ${w.path}`));
    const tags = (d?.tags ?? []).filter((x) => match(x.name)).slice(0, q ? 500 : 300);
    const stashes = (d?.stashes ?? []).filter((x) => match(x.subject));
    const base = (p) => p.replace(/\/+$/, "").split("/").pop();
    const body = !d ? [] : [
      this.section("local", "Local", "laptop", local.length,
        this.refTree("local", tree(local), 0, (b, name, depth) => this.refRow(`l-${b.name}`, depth, name, "git-branch", t,
          { current: b.name === shown, ahead: b.ahead, behind: b.behind, tip: b.name, act: (cx) => this.jump(b.sha, cx) }), t), t),
      this.section("remote", "Remote", "cloud", remote.length,
        this.refTree("remote", tree(remote), 0, (b, name, depth) => this.refRow(`r-${b.name}`, depth, name, "git-branch", t,
          { tip: b.name, act: (cx) => this.jump(b.sha, cx) }), t), t),
      this.section("worktrees", "Worktrees", "git-compare", wts.length,
        wts.map((w) => this.refRow(`w-${w.path}`, 0, w.branch ?? "detached", w.main ? "folder" : "git-branch", t, {
          current: w.branch === shown, extra: w.main ? "main checkout" : base(w.path),
          tint: w.prunable ? t.blocked : undefined,
          tip: `${tilde(w.path, f.machine)} · click to open its space`, act: () => this.openWorktree(w),
        })), t),
      this.section("stashes", "Stashes", "stash", stashes.length,
        stashes.map((s) => this.refRow(`s-${s.name}`, 0, s.subject.replace(/^(WIP on|On) [^:]+:\s*/, ""), "stash", t,
          { tip: `${s.name}: ${s.subject}`, act: (cx) => this.jump(s.base, cx) })), t),
      this.section("tags", "Tags", "tag", (d?.tags ?? []).filter((x) => match(x.name)).length,
        tags.map((x) => this.refRow(`t-${x.name}`, 0, x.name, "tag", t, { act: (cx) => this.jump(x.sha, cx) })), t),
    ];
    return v_flex().w(300).flex_none().min_h(0).border_r_1().border_color(t.border).bg(t.chrome)
      .child(h_flex().flex_none().px(10).pt(10).pb(8)
        .child(Input.new(this.input).flex_1().h(30).px(10).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground)))
      .child(div().relative().flex_1().min_h(0)
        .child(v_flex().id("refs-scroll").size_full().overflow_y_scroll().pb(12).children(body))
        .child(Scrollbar.vertical("refs-scroll").absolute().inset_0()));
  }

  // ---- Right: the graph ----

  // Which refs point at each commit, as pills: one per name, local and remote together.
  pills(d, f) {
    if (this.pillsFor === d) return this.pillMap;
    const wtBranches = new Set(d.worktrees.map((w) => w.branch).filter(Boolean));
    const remoteNames = new Set(d.remote.map((r) => r.name));
    const map = new Map();
    for (const c of d.commits) {
      const out = new Map();
      for (const raw of c.refs) {
        let r = raw.replace(/^HEAD -> /, "");
        if (r === "HEAD") continue;
        if (r.startsWith("tag: ")) { out.set(`tag:${r.slice(5)}`, { name: r.slice(5), tag: true }); continue; }
        const isRemote = remoteNames.has(r);
        const name = isRemote ? r.replace(/^[^/]+\//, "") : r;
        const p = out.get(name) ?? { name, local: false, remote: false, worktree: false };
        if (isRemote) p.remote = true; else { p.local = true; p.worktree = wtBranches.has(name); }
        out.set(name, p);
      }
      for (const s of d.stashes) if (s.base === c.sha) out.set(`stash:${s.name}`, { name: s.name, stash: true });
      if (out.size) map.set(c.sha, [...out.values()]);
    }
    this.pillsFor = d;
    this.pillMap = map;
    return map;
  }

  graphCell(c, width, t, dim, labeled) {
    const x = (i) => 12 + i * LANE + LANE / 2;
    const mid = ROW / 2;
    const paths = new Map(); // color -> PathBuilder
    const pen = (i) => {
      const color = laneColor(i);
      if (!paths.has(color)) paths.set(color, PathBuilder.stroke(2));
      return paths.get(color);
    };
    const curve = (b, x1, y1, x2, y2) => {
      b.move_to(x1, y1);
      if (x1 === x2) b.line_to(x2, y2);
      else b.cubic_bezier_to(x2, y2, x1, (y1 + y2) / 2, x2, (y1 + y2) / 2);
    };
    c.before.forEach((h, i) => {
      if (!h) return;
      if (h === c.sha) curve(pen(i === c.col ? c.col : i), x(i), 0, x(c.col), mid);
      else curve(pen(i), x(i), 0, x(i), ROW); // passes by
    });
    c.out.forEach((j) => curve(pen(j === c.col ? c.col : j), x(c.col), mid, x(j), ROW));
    // A labeled commit: its pill's line runs on to the dot.
    if (labeled) pen(c.col).move_to(0, mid).line_to(x(c.col), mid);
    const merge = c.parents.length > 1;
    const color = laneColor(c.col);
    return div().relative().w(width).h(ROW).flex_none().overflow_hidden()
      .children([...paths.entries()].map(([col, b]) => window.paint_path(b.build(), col).absolute().inset_0()))
      .child(merge
        ? div().absolute().left(x(c.col) - 5).top(mid - 5).size(10).rounded(5).bg(t.background).border_2().border_color(color)
        : h_flex().absolute().left(x(c.col) - NODE / 2).top(mid - NODE / 2).size(NODE).rounded(NODE / 2).bg(color)
          .border_2().border_color(t.background).items_center().justify_center()
          .text_size(7.5).font_bold().text_color("#ffffff").when(dim, (el) => el.opacity(0.55)).child(initials(c.author)));
  }

  pill(p, color, t, faded) {
    const glyph = p.tag ? "tag" : p.stash ? "stash" : null;
    return h_flex().h(20).px(6).gap(4).items_center().rounded(4).flex_shrink(1).min_w(0)
      .bg(`${color}${faded ? "40" : "cc"}`).text_size(11.5).font_medium().text_color("#ffffff")
      .when(Boolean(p.current), (el) => el.child(svg(icon("check")).size(11).flex_none()))
      .child(div().min_w(0).truncate().child(p.name))
      .when(Boolean(glyph), (el) => el.child(svg(icon(glyph)).size(11).flex_none()))
      .when(Boolean(p.local), (el) => el.child(svg(icon("laptop")).size(11).flex_none()))
      .when(Boolean(p.worktree), (el) => el.child(svg(icon("git-compare")).size(11).flex_none()))
      .when(Boolean(p.remote), (el) => el.child(svg(icon("cloud")).size(11).flex_none()));
  }

  commitRow(c, d, pills, width, t, onBranch, shown) {
    const dim = !onBranch.has(c.sha);
    const color = laneColor(c.col);
    const mine = (pills.get(c.sha) ?? []).map((p) => ({ ...p, current: p.local && p.name === shown }));
    mine.sort((a, b) => b.current - a.current || !!b.local - !!a.local || !!a.tag - !!b.tag);
    const selected = this.selected === c.sha;
    return h_flex().h(ROW).w_full().items_center()
      .when(selected, (el) => el.bg(t.selected))
      // Branch / tag
      .child(h_flex().w(230).flex_none().h_full().px(8).gap(4).items_center()
        .when(mine.length > 0, (el) => el.child(this.pill(mine[0], color, t, dim)))
        .when(mine.length > 1, (el) => el.child(div().flex_none().px(5).h(20).rounded(4).bg(`${color}55`).text_size(11).text_color("#ffffff")
          .flex().items_center().child(`+${mine.length - 1}`)))
        .when(mine.length > 0, (el) => el.child(div().flex_1().h(2).bg(`${color}88`).min_w(4))))
      // Graph
      .child(this.graphCell(c, width, t, dim, mine.length > 0))
      // Message
      .child(h_flex().flex_1().min_w(0).h_full().pl(6).pr(12).gap(10).items_center()
        .border_l_2().border_color(`${color}${dim ? "55" : "ff"}`)
        .when(!dim && mine.length > 0, (el) => el.bg(`${color}1a`))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(dim ? t.dim : t.foreground).child(c.subject))
        .child(div().flex_none().text_size(11.5).text_color(t.dim).child(c.author))
        .child(div().flex_none().w(34).text_size(11.5).text_color(t.dim).child(ago(c.at))));
  }

  detailPanel(t) {
    const sha = this.selected;
    if (!sha) return null;
    const d = this.detail[sha];
    const c = this.data?.commits[this.data.index.get(sha)];
    const ST = { A: t.ansi2, M: t.ansi3, D: t.ansi1, R: t.ansi4 };
    return v_flex().h(210).flex_none().border_t_1().border_color(t.border).bg(t.chrome)
      .child(h_flex().h(34).flex_none().px(14).gap(10).items_center().border_b_1().border_color(t.border)
        .child(div().text_size(12).font_semibold().text_color(t.foreground).font_family("monospace").child(sha.slice(0, 10)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(d ? `${d.author} · ${d.when}` : ""))
        .child(div().id("copy-sha").px(8).py(3).rounded(5).text_size(11.5).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.write_to_clipboard(sha); this.copied = sha; cx.notify(); })
          .child(this.copied === sha ? "Copied" : "Copy SHA"))
        .child(div().id("detail-close").px(8).py(3).rounded(5).text_size(11.5).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.selected = null; this.diff = null; cx.notify(); }).child("✕")))
      .child(h_flex().flex_1().min_h(0).items_stretch()
        .child(div().id("detail-msg").flex_1().min_w(0).p(14).overflow_y_scroll().text_size(12.5).text_color(t.foreground)
          .child(d ? d.body || c?.subject : "…"))
        .child(div().id("detail-files").w(380).flex_none().border_l_1().border_color(t.border).py(8).overflow_y_scroll()
          .children((d?.files ?? []).map((x, i) => {
            const on = this.diff?.sha === sha && this.diff.path === x.path;
            return h_flex().id(`df-${i}`).h(24).mx(6).px(8).gap(8).items_center().rounded(5).text_size(12).cursor_pointer()
              .tooltip(x.old ? `${x.old} → ${x.path}` : x.path)
              .when(on, (el) => el.bg(t.selected))
              .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
              .on_click((_e, cx) => this.openDiff(sha, x, cx))
              .child(div().w(12).flex_none().font_bold().text_color(ST[x.st] ?? t.muted).child(x.st))
              .child(div().flex_1().min_w(0).truncate().text_color(on ? t.foreground : t.muted).child(x.path));
          }))
          .when(Boolean(d) && !d.files.length, (el) => el.child(div().px(12).text_size(12).text_color(t.dim).child("No files changed")))));
  }

  // One file's change in commit `sha`, against its first parent.
  openDiff(sha, file, cx) {
    if (this.diff?.sha === sha && this.diff.path === file.path) { this.diff = null; cx.notify(); return; }
    const f = this.folder();
    const diff = this.diff = { sha, path: file.path, old: file.old, st: file.st, lines: null, error: null };
    cx.notify();
    cx.spawn(async (cx) => {
      const paths = file.old ? [file.old, file.path] : [file.path];
      const r = await exec("git", [...READ, "show", "--no-color", "--format=", "-M", "--first-parent", "-m", "-U4", sha, "--", ...paths],
        { cwd: f.dir, on: f.machine ?? null, timeout: 20000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      if (this.diff !== diff) return;
      if (r.code !== 0) { diff.error = (r.stderr || "git show failed").trim(); cx.notify(); return; }
      const lines = [];
      let a = 0, b = 0, inHunk = false;
      for (const raw of r.stdout.split("\n")) {
        if (lines.length >= DIFF_MAX) { lines.push({ kind: "note", text: `… cut at ${DIFF_MAX} lines` }); break; }
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(raw);
        if (hunk) { a = +hunk[1]; b = +hunk[2]; inHunk = true; lines.push({ kind: "hunk", text: raw }); continue; }
        if (/^Binary files/.test(raw)) { lines.push({ kind: "note", text: "Binary file: no text to show" }); continue; }
        if (!inHunk || raw.startsWith("diff --git")) { inHunk = false; continue; }
        const text = raw.slice(1).replace(/\t/g, "    ");
        if (raw[0] === "+") lines.push({ kind: "add", b: b++, text });
        else if (raw[0] === "-") lines.push({ kind: "del", a: a++, text });
        else if (raw[0] === " ") lines.push({ kind: "ctx", a: a++, b: b++, text });
        else if (raw[0] === "\\") lines.push({ kind: "note", text: raw.slice(2) });
      }
      if (!lines.length) lines.push({ kind: "note", text: file.st === "R" ? "Renamed without changes" : "No changes to show" });
      diff.lines = lines;
      diff.adds = lines.filter((l) => l.kind === "add").length;
      diff.dels = lines.filter((l) => l.kind === "del").length;
      cx.notify();
    });
  }

  diffView(t) {
    const d = this.diff;
    const files = this.detail[d.sha]?.files ?? [];
    const at = files.findIndex((x) => x.path === d.path);
    const step = (by) => (_e, cx) => { const x = files[at + by]; if (x) this.openDiff(d.sha, x, cx); };
    const navBtn = (id, label, act, enabled) => div().id(id).px(8).h(24).flex().items_center().rounded(5).text_size(12)
      .text_color(enabled ? t.muted : t.dim).when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(act))
      .child(label);
    const mono = settings().font_family ?? "JetBrains Mono";
    const bg = { add: `${t.ansi2}26`, del: `${t.ansi1}26`, hunk: `${t.accent}1a` };
    const sign = { add: "+", del: "−", ctx: " " };
    const line = (l) => {
      if (l.kind === "hunk" || l.kind === "note") return h_flex().h(DIFF_ROW).w_full().px(10).items_center()
        .when(l.kind === "hunk", (el) => el.bg(bg.hunk)).text_color(t.dim).child(div().truncate().child(l.text));
      return h_flex().h(DIFF_ROW).w_full().items_center().when(Boolean(bg[l.kind]), (el) => el.bg(bg[l.kind]))
        .child(div().w(46).flex_none().pr(6).text_right().text_color(t.dim).child(l.a !== undefined ? String(l.a) : ""))
        .child(div().w(46).flex_none().pr(6).text_right().text_color(t.dim).child(l.b !== undefined ? String(l.b) : ""))
        .child(div().w(16).flex_none().text_color(l.kind === "add" ? t.ansi2 : l.kind === "del" ? t.ansi1 : t.dim).child(sign[l.kind]))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(l.text || " "));
    };
    return v_flex().flex_1().min_w(0).min_h(0)
      .child(h_flex().h(34).flex_none().px(8).gap(8).items_center().border_b_1().border_color(t.border).bg(t.chrome)
        .child(navBtn("diff-back", "← Graph", (_e, cx) => { this.diff = null; cx.notify(); }, true))
        .child(div().w(1).h(16).bg(t.border))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground)
          .child(d.old ? `${d.old} → ${d.path}` : d.path))
        .when(Boolean(d.lines), (el) => el
          .child(div().text_size(12).text_color(t.ansi2).child(`+${d.adds}`))
          .child(div().text_size(12).text_color(t.ansi1).child(`−${d.dels}`)))
        .child(navBtn("diff-prev", "↑", step(-1), at > 0))
        .child(navBtn("diff-next", "↓", step(1), at >= 0 && at < files.length - 1))
        .child(div().text_size(11.5).text_color(t.dim).child(at >= 0 ? `${at + 1}/${files.length}` : "")))
      .child(d.error ? div().p(16).text_size(12.5).text_color(t.blocked).child(d.error)
        : !d.lines ? div().p(16).text_size(12.5).text_color(t.dim).child("Loading…")
        : div().relative().flex_1().min_h(0).font_family(mono).text_size(12)
          .child(v_virtual_list(`diff-${d.sha}-${d.path}`, d.lines.length, DIFF_ROW, (i) => String(i),
            (range) => d.lines.slice(range.start, range.end).map(line)).size_full())
          .child(Scrollbar.vertical(`diff-${d.sha}-${d.path}`).absolute().inset_0()));
  }

  graphPanel(t, f) {
    const d = this.data;
    const width = Math.max(72, 24 + Math.min(Math.max(d.widest, 1), MAX_LANES) * LANE);
    const pills = this.pills(d, f);
    const shown = this.shownBranch(f) ?? d.head;
    const tip = d.local.find((b) => b.name === shown)?.sha;
    const onBranch = tip ? this.reach(tip) : new Set(d.commits.map((c) => c.sha));
    const head = (label, w) => div().when(w !== null, (el) => el.w(w).flex_none()).when(w === null, (el) => el.flex_1())
      .px(8).text_size(11).font_medium().text_color(t.dim).child(label);
    if (this.diff && this.diff.sha === this.selected) return v_flex().flex_1().min_w(0).min_h(0)
      .child(this.diffView(t))
      .child(this.detailPanel(t));
    return v_flex().flex_1().min_w(0).min_h(0)
      .child(h_flex().h(30).flex_none().items_center().border_b_1().border_color(t.border).bg(t.chrome)
        .child(head("BRANCH / TAG", 230)).child(head("GRAPH", width)).child(head("COMMIT MESSAGE", null)))
      .child(div().relative().flex_1().min_h(0)
        .child(v_virtual_list("graph", d.commits.length, ROW, (i) => d.commits[i].sha,
          (range) => d.commits.slice(range.start, range.end).map((c) => this.commitRow(c, d, pills, width, t, onBranch, shown)))
          .size_full().track_scroll(this.scroll)
          .on_item_click((sha, cx) => this.select(sha, cx)))
        .child(Scrollbar.vertical("graph").absolute().inset_0()))
      .when(Boolean(this.note), (el) => el.child(div().flex_none().px(14).py(6).text_size(12).text_color(t.dim).child(this.note)))
      .when(Boolean(this.selected), (el) => el.child(this.detailPanel(t)));
  }

  // A folder outside git: its spaces, to go to.
  plainPanel(t, f) {
    const ids = new Set(f?.spaces ?? []);
    return v_flex().flex_1().p(24).gap(8)
      .child(div().text_size(13).text_color(t.dim).child(f ? "This folder is not a git repository." : "No folder selected."))
      .children(spaces().filter((s) => ids.has(s.id)).map((s) => h_flex().id(`plain-${s.id}`).h(32).px(12).gap(8).items_center().rounded(7)
        .bg(t.background).border_1().border_color(t.border).cursor_pointer().hover((st) => st.border_color(t.accent))
        .on_click(() => { run("layout.select", { stack: "work-stack", child: "work" }); run("space.select", { id: s.id }); })
        .child(svg(icon("terminal")).size(13).text_color(t.muted)).child(div().text_size(13).text_color(t.foreground).child(s.name))));
  }

  render(cx) {
    this.back();
    const t = theme(), f = this.folder();
    if (f?.key !== this.lastFolder) {
      this.lastFolder = f?.key;
      this.data = null; this.error = null; this.selected = null; this.detail = {}; this.note = null;
      if (f?.git) this.refresh(cx);
    }
    const button = (id, label, glyph, act, busy) => h_flex().id(id).gap(6).px(10).h(28).rounded(6).items_center().text_size(12).text_color(t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(act)
      .child(svg(icon(glyph)).size(13).when(Boolean(busy), (el) => el.spin(900))).child(label);
    const d = this.data;
    const counts = d ? `${d.local.length} branches · ${d.worktrees.length} worktrees · ${d.commits.length}${d.commits.length >= LIMIT ? "+" : ""} commits` : "";
    return v_flex().id("folder-overview").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.canvas).border_1().border_color(t.border)
      // Header
      .child(h_flex().h(52).flex_none().px(16).gap(12).items_center().border_b_1().border_color(t.border).bg(t.chrome)
        .child(svg(icon("folder")).size(18).flex_none().text_color(t.muted))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(15).font_semibold().text_color(t.foreground).truncate().child(f?.name ?? "Folder"))
          .child(div().text_size(11.5).text_color(t.dim).truncate().child([tilde(f?.dir, f?.machine), f?.machine, counts].filter(Boolean).join(" · "))))
        .when(Boolean(f?.git), (el) => el
          .child(button("ov-fetch", this.fetching ? "Fetching…" : "Fetch", "refresh", (_e, cx) => this.refresh(cx, true), this.fetching))
          .child(button("ov-new", "New branch", "git-branch",
            () => openOverlay({ mod: "issue-worktree", kind: "dialog", width: 580, height: 500, props: { folder: f.dir, machine: f.machine, action: "new" } }))))
        .child(button("ov-close", "Close", "x", () => run("layout.select", { stack: "work-stack", child: "work" }))))
      .when(Boolean(this.error), (el) => el.child(div().flex_none().px(16).py(6).text_size(12).text_color(t.blocked).child(this.error)))
      // Body
      .child(h_flex().flex_1().min_h(0).items_stretch()
        .when(Boolean(f?.git), (el) => el
          .child(this.refsPanel(t, f))
          .child(d ? this.graphPanel(t, f) : div().flex_1().p(24).text_size(13).text_color(t.dim).child(this.loading ? "Loading…" : "")))
        .when(!f?.git, (el) => el.child(this.plainPanel(t, f))));
  }
}
