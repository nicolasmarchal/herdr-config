// History for the Coding layout: the repo's commits (newest first). Select one to
// see what it changed; click a file to open that change in the editor block
// (setShared("editor.open", { path, commit })), with Changes / Old / New views.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, theme, setShared, run, layout } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  // A mod pane (the editor) has no folder: use the tab's first terminal instead.
  const tabTerm = panes().find(p => p.tab === (pane?.tab ?? f?.tab) && p.terminal && p.cwd);
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || tabTerm?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const PAGE = 150;
const SEP = "\x1f", END = "\x1e";

export default class History extends View {
  init(_props, cx) {
    this.commits = []; this.files = {}; this.open = null; this.picked = null;
    this.limit = PAGE;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx, true));
  }

  refresh(cx, quiet = false) {
    if (this.loading) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.commits = []; this.files = {}; this.open = null; this.error = null; this.limit = PAGE;
    }
    if (!cwd) return;
    this.loading = !quiet;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.commits = []; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const [log, branch, ahead] = await Promise.all([
          git(["log", `-${this.limit}`, `--format=%H${SEP}%h${SEP}%s${SEP}%an${SEP}%ar${SEP}%D${END}`]),
          git(["branch", "--show-current"]),
          git(["rev-list", "@{u}..HEAD"]),
        ]);
        if (key() !== context) return;
        if (log.code !== 0) { this.commits = []; this.error = /does not have any commits/.test(log.stderr) ? "No commits yet" : log.stderr.trim(); return; }
        const unpushed = new Set(ahead.code === 0 ? ahead.stdout.split("\n").filter(Boolean) : []);
        this.noUpstream = ahead.code !== 0;
        this.commits = log.stdout.split(END).map((r) => r.replace(/^\n/, "")).filter(Boolean).map((r) => {
          const [sha, short, subject, author, when, refs] = r.split(SEP);
          return { sha, short, subject, author, when, refs: (refs ?? "").split(", ").filter(Boolean), unpushed: unpushed.has(sha) };
        });
        this.root = root; this.on = on; this.branch = branch.stdout.trim(); this.error = null;
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // The files a commit changed, with +/− counts.
  select(c, cx) {
    this.open = this.open === c.sha ? null : c.sha;
    if (!this.open || this.files[c.sha]) return cx.notify();
    const root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      const git = (args) => exec("git", [...READ, ...args], { cwd: root, on }).catch(() => null);
      const [status, stat] = await Promise.all([
        git(["show", "--format=", "--first-parent", "--name-status", "-z", "--no-renames", c.sha]),
        git(["show", "--format=", "--first-parent", "--numstat", "-z", "--no-renames", c.sha]),
      ]);
      const counts = {};
      for (const entry of (stat?.stdout ?? "").split("\0")) {
        const [a, d, ...rest] = entry.replace(/^\n/, "").split("\t");
        if (rest.length) counts[rest.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0 };
      }
      const parts = (status?.stdout ?? "").split("\0").map((x) => x.replace(/^\n/, "")).filter(Boolean), files = [];
      for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i][0], path: parts[i + 1], ...(counts[parts[i + 1]] ?? { add: 0, del: 0 }) });
      this.files[c.sha] = files;
      cx.notify();
    });
    cx.notify();
  }

  show(c, f) {
    this.picked = `${c.sha}:${f.path}`;
    setShared("editor.open", { path: `${this.root}/${f.path}`, commit: c.sha, n: Date.now() });
    const find = (n) => n?.id === "editor" ? n : (n?.children ?? []).map(find).find(Boolean);
    if (find(layout())?.hidden) run("layout.show", { id: "editor" });
  }

  fileRow(c, f, t) {
    const parts = f.path.split("/"), name = parts.pop(), on = this.picked === `${c.sha}:${f.path}`;
    return h_flex().id(`hf-${c.sha}-${f.path}`).h(26).flex_none().pl(28).pr(8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.show(c, f); cx.notify(); })
      .child(div().w(12).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : t.blocked).child(f.status))
      .child(h_flex().flex_1().min_w(0).text_size(12)
        .child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : ""))
        .child(div().flex_none().max_w(220).truncate().child(name)))
      .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  commitRow(c, t) {
    const open = this.open === c.sha;
    const tags = c.refs.filter((r) => r !== "HEAD").map((r) => r.replace(/^HEAD -> /, "").replace(/^tag: /, "🏷 "));
    return v_flex().flex_none()
      .child(h_flex().id(`hc-${c.sha}`).flex_none().px(8).py(6).gap(8).items_start().rounded(7).cursor_pointer()
        .when(open, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.select(c, cx))
        .child(div().mt(4).size(8).flex_none().rounded(4).border_2().border_color(c.unpushed ? t.accent : t.dim).when(c.unpushed, (e) => e.bg(t.accent)))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(12.5).text_color(t.foreground).truncate().child(c.subject || "(no message)"))
          .child(h_flex().gap(6).text_size(11).text_color(t.dim)
            .child(div().font_family("JetBrains Mono").child(c.short))
            .child(div().truncate().child(`${c.author} · ${c.when}`)))
          .when(tags.length > 0, (e) => e.child(h_flex().gap(4).flex_wrap().children(tags.slice(0, 3).map((r) =>
            div().px(5).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).max_w(180).truncate().child(r)))))))
      .when(open, (e) => e.child(v_flex().py(2).children(
        this.files[c.sha] ? (this.files[c.sha].length ? this.files[c.sha].map((f) => this.fileRow(c, f, t))
          : [div().pl(28).py(4).text_size(11.5).text_color(t.dim).child("No file changes (merge)")])
          : [div().pl(28).py(4).text_size(11.5).text_color(t.dim).child("Loading files…")])));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), unpushed = this.commits.filter((c) => c.unpushed).length;
    return v_flex().id("history").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("History"))
        .when(Boolean(this.branch), (e) => e.child(h_flex().gap(4).items_center().text_size(11.5).text_color(t.muted)
          .child(svg("mods/workspace-chrome/git-branch.svg").size(12)).child(div().max_w(140).truncate().child(this.branch))))
        .child(div().flex_1())
        .when(unpushed > 0, (e) => e.child(div().text_size(11).text_color(t.accent).child(`↑${unpushed} not pushed`)))
        .when(this.noUpstream && this.commits.length > 0, (e) => e.child(div().text_size(11).text_color(t.dim).child("no upstream"))))
      .child(v_flex().id("history-list").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .children(this.commits.map((c) => this.commitRow(c, t)))
        .when(this.commits.length >= this.limit, (e) => e.child(div().id("history-more").mx(8).my(6).py(6).rounded(6).text_size(12).text_color(t.muted)
          .flex().justify_center().cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.limit += PAGE; this.refresh(cx); }).child("Load older commits")))
        .when(!this.commits.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading history…" : this.root ? "No commits" : "No folder")))));
  }
}
