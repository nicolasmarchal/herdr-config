// A folder's overview page: one card per space in the folder (shared
// "folder.overview" = folder id), with its branch, ahead/behind, uncommitted
// changes, last commit, and what each agent is doing. Click a card to go to
// that space. Shown in the layout's "work-stack" stack, in place of the whole
// right side (tab bar, tab, status bar); picking a space or tab
// (here, in the sidebar or by key) goes back to the tab.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, agents, shared, theme, run, exec, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const r = find(c, id); if (r) return r; }
  return null;
}

const STATUS = { blocked: "Needs you", done: "Finished", working: "Working", idle: "Idle" };
const ORDER = { blocked: 0, done: 1, working: 2, idle: 3 };

function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.terminal && p.cwd)?.cwd || s.folder;
}

export default class FolderOverview extends View {
  init(_props, cx) {
    this.git = {}; // space id -> summary
    this.refresh(cx);
    cx.timer.every(15000, (cx) => { if (this.shown()) this.refresh(cx); });
  }

  folder() {
    const id = shared("folder.overview"), all = shared("space.folders");
    return Array.isArray(all) ? all.find((f) => f.id === id) ?? null : null;
  }

  // The folder's spaces, and the worktree spaces filed under them by the sidebar
  // (same repo): everything that isn't in another folder and lives in a folder space's repo.
  members() {
    const f = this.folder();
    if (!f) return [];
    const all = spaces(), ids = new Set(f.spaces);
    const repos = new Set(f.spaces.map((id) => this.git[id]?.repo).filter(Boolean));
    const elsewhere = new Set((shared("space.folders") ?? []).filter((x) => x.id !== f.id).flatMap((x) => x.spaces));
    return all.filter((s) => ids.has(s.id) || (!elsewhere.has(s.id) && this.git[s.id]?.repo && repos.has(this.git[s.id].repo)));
  }

  shown() {
    return shared("folder.overview") && this.folder();
  }

  // Leave for the tab when the person picks another space or tab than the one
  // they were on when they opened the page (recorded by the sidebar's click).
  back() {
    if (find(layout(), "work-stack")?.active !== "overview") return;
    const s = spaces().find((x) => x.active), now = `${s?.id}|${s?.tabs?.find((t) => t.active)?.id}`;
    const from = shared("folder.overview.from");
    if (from && now !== from) run("layout.select", { stack: "work-stack", child: "work" });
  }

  refresh(cx) {
    const list = spaces();
    cx.spawn(async (cx) => {
      for (const s of list) {
        const cwd = place(s), on = s.machine ?? null;
        if (!cwd) continue;
        const git = (args) => exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], { cwd, on, timeout: 8000 }).catch(() => null);
        const [st, log, stat, common] = await Promise.all([
          git(["status", "--porcelain=v1", "-b", "--untracked-files=normal"]),
          git(["log", "-1", "--format=%s%x00%cr"]),
          git(["diff", "HEAD", "--shortstat"]),
          git(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        ]);
        if (st?.code !== 0) { this.git[s.id] = null; continue; }
        const lines = st.stdout.split("\n").filter(Boolean), head = lines[0] ?? "";
        const ahead = +(/ahead (\d+)/.exec(head)?.[1] ?? 0), behind = +(/behind (\d+)/.exec(head)?.[1] ?? 0);
        const [subject, when] = (log?.stdout ?? "").trim().split("\0");
        const add = +(/(\d+) insertion/.exec(stat?.stdout ?? "")?.[1] ?? 0), del = +(/(\d+) deletion/.exec(stat?.stdout ?? "")?.[1] ?? 0);
        this.git[s.id] = { ahead, behind, changed: lines.length - 1, add, del, subject, when, repo: common?.stdout?.trim() || null,
          upstream: head.includes("...") };
      }
      cx.notify();
    });
  }

  card(s, t) {
    const g = this.git[s.id];
    const list = agents().filter((a) => a.space === s.id).sort((a, b) => ORDER[a.status] - ORDER[b.status]);
    const chip = (text, color) => div().px(6).py(1).rounded(4).bg(t.raised).text_size(11).text_color(color ?? t.muted).child(text);
    return v_flex().id(`ov-${s.id}`).w(340).flex_none().p(14).gap(10).rounded(10).bg(t.background).border_1()
      .border_color(s.status === "blocked" ? t.blocked : t.border).cursor_pointer().hover((st) => st.border_color(t.accent))
      .on_click(() => { run("space.select", { id: s.id }); run("layout.select", { stack: "work-stack", child: "work" }); })
      // Name and branch
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().text_color(t.foreground).child(s.name))
        .when(Boolean(s.status) && s.status !== "idle", (el) => el.child(div().size(8).rounded(4).bg(t[s.status] ?? t.unknown))))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .when(Boolean(s.branch), (el) => el.child(h_flex().gap(4).items_center().text_size(12).text_color(t.muted)
          .child(svg("mods/workspace-chrome/git-branch.svg").size(12)).child(div().max_w(200).truncate().child(s.branch))))
        .when(Boolean(g?.ahead), (el) => el.child(chip(`↑${g.ahead}`, t.ansi2)))
        .when(Boolean(g?.behind), (el) => el.child(chip(`↓${g.behind}`, t.ansi3)))
        .when(Boolean(g) && !g.upstream && Boolean(s.branch), (el) => el.child(chip("not pushed")))
        .when(Boolean(s.machine), (el) => el.child(chip(s.machine))))
      // Working tree
      .child(g === null ? div().text_size(12).text_color(t.dim).child("Not a git repository")
        : !g ? div().text_size(12).text_color(t.dim).child("Loading…")
        : v_flex().gap(4)
          .child(h_flex().gap(8).items_center().text_size(12)
            .child(div().text_color(g.changed ? t.foreground : t.dim).child(g.changed ? `${g.changed} changed file${g.changed > 1 ? "s" : ""}` : "Clean"))
            .when(g.add > 0, (el) => el.child(div().text_color(t.ansi2).child(`+${g.add}`)))
            .when(g.del > 0, (el) => el.child(div().text_color(t.ansi1).child(`−${g.del}`))))
          .when(Boolean(g.subject), (el) => el.child(h_flex().gap(6).text_size(12).text_color(t.muted)
            .child(div().flex_1().min_w(0).truncate().child(g.subject)).child(div().flex_none().text_color(t.dim).child(g.when ?? "")))))
      // Agents
      .child(div().h(1).bg(t.border))
      .child(list.length === 0
        ? div().text_size(12).text_color(t.dim).child(`No agents · ${s.tabs.length} tab${s.tabs.length > 1 ? "s" : ""}`)
        : v_flex().gap(6).children(list.slice(0, 6).map((a) => h_flex().id(`ova-${a.address}`).gap(8).items_center().text_size(12)
            .on_click((_e, cx) => { cx.stop_propagation(); run("agent.focus", { terminal: a.address }); run("layout.select", { stack: "work-stack", child: "work" }); })
            .child(div().size(7).flex_none().rounded(4).bg(t[a.status] ?? t.unknown))
            .child(div().flex_none().text_color(t.foreground).child(a.program?.name ?? a.app ?? "Agent"))
            .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(a.title || a.tab_name))
            .child(div().flex_none().text_size(11).text_color(a.status === "blocked" ? t.blocked : t.dim).child(STATUS[a.status] ?? a.status))))
          .when(list.length > 6, (el) => el.child(div().text_size(11).text_color(t.dim).child(`+${list.length - 6} more`))));
  }

  render(cx) {
    this.back();
    const t = theme(), f = this.folder(), members = this.members();
    if (f && f.id !== this.lastFolder) { this.lastFolder = f.id; this.refresh(cx); }
    const counts = {};
    for (const a of agents()) if (members.some((s) => s.id === a.space)) counts[a.status] = (counts[a.status] ?? 0) + 1;
    return v_flex().id("folder-overview").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.canvas).border_1().border_color(t.border)
      .child(h_flex().flex_none().px(24).pt(22).pb(14).gap(12).items_center()
        .child(svg("mods/workspace-chrome/folder.svg").size(22).text_color(t.muted))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(22).font_semibold().text_color(t.foreground).truncate().child(f?.name ?? "Folder"))
          .child(div().text_size(12).text_color(t.dim).child(`${members.length} space${members.length === 1 ? "" : "s"}` +
            ["blocked", "done", "working"].filter((k) => counts[k]).map((k) => ` · ${counts[k]} ${STATUS[k].toLowerCase()}`).join(""))))
        .child(div().id("ov-close").px(10).py(4).rounded(6).text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("layout.select", { stack: "work-stack", child: "work" })).child("Close  ✕")))
      .child(div().id("ov-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(24).pb(24)
        .child(h_flex().flex_wrap().gap(14).items_start().children(members.map((s) => this.card(s, t))))
        .when(!members.length, (el) => el.child(div().pt(40).text_size(13).text_color(t.dim)
          .child(f ? "This folder is empty. Use its + in the sidebar, or drag a space onto it." : "No folder selected."))));
  }
}
