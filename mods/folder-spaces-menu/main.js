// Menus and the name dialog for the folder-spaces sidebar. Opened as an overlay
// with props:
//   { kind: "space", space, head }  a space's right-click menu (Herdr's space items
//                                   plus folder items; `head` is the space whose
//                                   folder counts: a worktree follows its repo's)
//   { kind: "folder", folder }      a folder's right-click menu
//   { kind: "name", folder?, space?, title }
//                                   a name dialog: renames `folder`, else makes a new
//                                   folder (with `space` in it, when given)
// Folders live in shared("space.folders"): [{ id, name, collapsed, spaces: [id] }].

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, spaces, panes, exec, shared, setShared } from "herdr";

const KEY = "space.folders";

export function readFolders() {
  const raw = shared(KEY);
  return Array.isArray(raw) ? raw.filter((f) => f && typeof f.id === "string").map((f) => ({
    id: f.id, name: String(f.name ?? "Folder"), collapsed: !!f.collapsed,
    spaces: Array.isArray(f.spaces) ? f.spaces.filter((s) => typeof s === "string") : [],
  })) : [];
}

const save = (list) => setShared(KEY, list);

// Puts `space` in folder `to` (null: back to the top level), out of any other.
function moveTo(space, to) {
  save(readFolders().map((f) => ({
    ...f,
    spaces: f.id === to ? [...f.spaces.filter((s) => s !== space), space] : f.spaces.filter((s) => s !== space),
  })));
}

const newId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

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
  openOverlay({ mod: "worktree", kind: "dialog", ...(args.action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: args });
}

// Each item: { label, icon, act, sep? (a line above it), dim? }.
function items(p, git) {
  const folders = readFolders();
  if (p.kind === "folder") {
    const f = folders.find((x) => x.id === p.folder);
    if (!f) return [];
    return [
      { label: "Rename folder…", icon: "square-pen", act: () => openName({ folder: f.id, title: "Rename folder" }) },
      { label: f.collapsed ? "Expand" : "Collapse", icon: f.collapsed ? "chevron-down" : "chevron-right",
        act: () => save(readFolders().map((x) => (x.id === f.id ? { ...x, collapsed: !x.collapsed } : x))) },
      { label: "New folder…", icon: "folder-plus", act: () => openName({ title: "New folder" }) },
      { label: "Delete folder", icon: "x", sep: true, act: () => save(readFolders().filter((x) => x.id !== f.id)) },
    ];
  }
  // A space.
  const id = p.space, head = p.head ?? p.space;
  const current = folders.find((f) => f.spaces.includes(head));
  const follows = head !== id;
  const spaceItems = [
    { label: "Rename", icon: "square-pen", act: () => run("space.rename", { id }) },
    ...(git ? [
      { label: "New worktree", icon: "git-branch", act: () => worktree({ space: id, action: "new" }) },
      { label: "Open worktree", icon: "git-branch", act: () => worktree({ space: id, action: "open" }) },
    ] : []),
    ...(git === "linked" ? [{ label: "Remove worktree", icon: "git-branch", act: () => worktree({ space: id, action: "remove" }) }] : []),
  ];
  const folderItems = [
    ...folders.filter((f) => f.id !== current?.id).map((f, n) => ({
      label: `Move to ${f.name}`, icon: "folder", sep: n === 0, act: () => moveTo(head, f.id),
    })),
    { label: follows ? "New folder with its repo…" : "New folder…", icon: "folder-plus", sep: !folders.some((f) => f.id !== current?.id),
      act: () => openName({ space: head, title: "New folder" }) },
    ...(current ? [{ label: `Remove from ${current.name}`, icon: "minus", act: () => moveTo(head, null) }] : []),
  ];
  return [...spaceItems, ...folderItems, { label: "Close", icon: "x", sep: true, act: () => run("space.close", { id }) }];
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
    const f = p.folder && readFolders().find((x) => x.id === p.folder);
    this.text = f ? f.name : "";
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
    if (!name) return;
    const list = readFolders();
    if (p.folder) {
      save(list.map((f) => (f.id === p.folder ? { ...f, name } : f)));
    } else {
      const fresh = { id: newId(), name, collapsed: false, spaces: p.space ? [p.space] : [] };
      save([...list.map((f) => ({ ...f, spaces: f.spaces.filter((s) => s !== p.space) })), fresh]);
    }
  }

  render(t, handle) {
    const p = props() ?? {};
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("fsm-name").track_focus(handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(p.title ?? "Folder"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(16).pb(7).text_size(11.5).text_color(t.dim).child("Name"))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(h_flex().pt(20).gap(8).justify_end()
        .child(button("fsm-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button("fsm-save", p.folder ? "Rename" : "Create", true, () => this.submit())));
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
