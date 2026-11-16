// Menus and the name dialog for the folder-spaces sidebar. Opened as an overlay
// with props:
//   { kind: "space", space }    a space's right-click menu
//   { kind: "folder", key }     a folder's right-click menu (key: the sidebar's
//                               folder key, described in shared("folder.groups"))
//   { kind: "name", key, title } a name dialog: the folder's display name
// Folder names and folds live in shared("space.groups"): { [key]: { name?, collapsed? } }.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, spaces, panes, exec, shared, setShared } from "herdr";

const GROUPS = "space.groups";
const prefs = () => {
  const raw = shared(GROUPS);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
};
const setPref = (key, patch) => setShared(GROUPS, { ...prefs(), [key]: { ...(prefs()[key] ?? {}), ...patch } });
const group = (key) => (shared("folder.groups") ?? {})[key] ?? null;

function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

const icon = (name) => `mods/workspace-chrome/${name}.svg`;

function openName(p) {
  openOverlay({ mod: "folder-spaces-menu", kind: "dialog", width: 400, height: 210, props: { kind: "name", ...p } });
}

function worktree(args) {
  openOverlay({ mod: "issue-worktree", kind: "dialog", ...(args.action === "remove" ? { width: 440, height: 260 } : { width: 580, height: 500 }), props: args });
}

const overview = (key) => {
  const sp = spaces().find((x) => x.active);
  setShared("folder.overview.from", `${sp?.id}|${sp?.tabs?.find((x) => x.active)?.id}`);
  setShared("folder.overview", key);
  run("layout.select", { stack: "work-stack", child: "overview" });
};

// Each item: { label, icon, act, sep? (a line above it) }.
function items(p, git) {
  if (p.kind === "folder") {
    const f = group(p.key);
    if (!f) return [];
    const collapsed = !!prefs()[p.key]?.collapsed;
    const at = { folder: f.dir, machine: f.machine };
    return [
      ...(f.git ? [
        { label: "New branch (worktree)…", icon: "git-branch", act: () => worktree({ ...at, action: "new" }) },
        { label: "Open worktree…", icon: "git-compare", act: () => worktree({ ...at, action: "open" }) },
      ] : [{ label: "New space here", icon: "plus", act: () => run("space.new", { folder: f.dir, machine: f.machine ?? "" }) }]),
      { label: "Overview", icon: "layers", sep: true, act: () => overview(p.key) },
      ...(!f.machine ? [{ label: "Show in Finder", icon: "folder", act: () => exec("open", [f.dir]) }] : []),
      { label: "Rename…", icon: "square-pen", sep: true, act: () => openName({ key: p.key, title: "Rename folder" }) },
      ...(f.alias ? [{ label: "Use directory name", icon: "x", act: () => setPref(p.key, { name: null }) }] : []),
      { label: collapsed ? "Expand" : "Collapse", icon: collapsed ? "chevron-down" : "chevron-right", act: () => setPref(p.key, { collapsed: !collapsed }) },
    ];
  }
  // A space.
  const id = p.space;
  return [
    { label: "Rename space", icon: "square-pen", act: () => run("space.rename", { id }) },
    ...(git ? [
      { label: "New branch from here…", icon: "git-branch", sep: true, act: () => worktree({ space: id, action: "new" }) },
      { label: "Open worktree…", icon: "git-compare", act: () => worktree({ space: id, action: "open" }) },
    ] : []),
    ...(git === "linked" ? [{ label: "Remove worktree…", icon: "archive", act: () => worktree({ space: id, action: "remove" }) }] : []),
    { label: "Close space", icon: "x", sep: true, act: () => run("space.close", { id }) },
  ];
}

class Menu {
  constructor(view, cx) {
    this.view = view;
    this.at = 0;
    this.git = null;
    const p = props() ?? {};
    const space = p.kind === "space" && spaces().find((s) => s.id === p.space);
    const folder = space && place(space);
    if (folder) cx.spawn(async (cx) => { this.git = await checkout(folder, space.machine).catch(() => null); cx.notify(); });
  }

  choose(i) {
    const it = items(props() ?? {}, this.git)[i];
    if (!it) return;
    closeOverlay(props()?.overlay);
    it.act();
  }

  render(t, handle) {
    const list = items(props() ?? {}, this.git);
    return v_flex().id("fsm").track_focus(handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (!list.length) return;
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(list.map((it, i) => v_flex()
        .when(i > 0 && !!it.sep, (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id(`fsm-${i}`).h(31).px(8).gap(9).rounded(7).items_center().text_color(t.foreground)
          .when(i === this.at, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.choose(i))
          .child(svg(icon(it.icon)).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(it.label)))));
  }
}

class Name {
  constructor(cx) {
    const p = props() ?? {};
    this.text = group(p.key)?.name ?? "";
    this.input = InputState.new({ value: this.text, placeholder: "Folder name" });
    if (this.text) this.input.set_selected_range({ start: 0, end: this.text.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", () => this.submit());
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
  }

  submit() {
    const p = props() ?? {};
    const name = this.text.trim();
    closeOverlay(p.overlay);
    // Empty: back to the directory's own name.
    if (p.key) setPref(p.key, { name: name || null });
  }

  render(t, handle) {
    const p = props() ?? {};
    const f = group(p.key);
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("fsm-name").track_focus(handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(p.title ?? "Folder"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(16).pb(7).text_size(11.5).text_color(t.dim).truncate()
        .child(f ? `Name shown for ${f.dir} (empty: its own name)` : "Name"))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(h_flex().pt(20).gap(8).justify_end()
        .child(button("fsm-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button("fsm-save", "Rename", true, () => this.submit())));
  }
}

export default class FolderSpacesMenu extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    if ((props() ?? {}).kind === "name") this.part = new Name(cx);
    else { this.part = new Menu(this, cx); this.handle.focus(); }
  }

  render() {
    return this.part.render(theme(), this.handle);
  }
}
