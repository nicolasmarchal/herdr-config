// Tab bar for the Standard and Coding layouts: Herdr's tab bar, plus
// - panels remembered per tab (shared "tab.panels"): a new tab starts with only
//   its terminals, full size; each tab gets back its own panel/editor/terminal state,
// - Editor / Terminal toggles and terminal above/below (Coding only),
// - Open in Xcode / Android Studio when the tab's repo is one.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, setShared, layout, settings, exec, notify } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    // IDE detection resolves outside render; redraw once it lands.
    cx.timer.every(500, (cx) => { if (this.notifyLater) { this.notifyLater = false; cx.notify(); } });
  }

  // What this tab shows. Missing nodes (Standard has no editor) are left out.
  current(root) {
    const panel = find(root, "panel"), body = find(root, "panel-body"), editor = find(root, "editor"), term = find(root, "main");
    const now = {};
    if (panel) now.panel = panel.hidden ? null : body?.active ?? null;
    if (editor) now.editor = !editor.hidden;
    if (term && editor) now.terminal = !term.hidden;
    return now;
  }

  apply(want, now) {
    if ("panel" in now && want.panel !== now.panel) {
      if (want.panel) { run("layout.select", { stack: "panel-body", child: want.panel }); run("layout.show", { id: "panel" }); }
      else run("layout.hide", { id: "panel" });
    }
    if ("editor" in now && want.editor !== now.editor) run(want.editor ? "layout.show" : "layout.hide", { id: "editor" });
    if ("terminal" in now && want.terminal !== now.terminal) run(want.terminal ? "layout.show" : "layout.hide", { id: "main" });
  }

  // Each tab keeps its own panels; a tab never seen starts bare (terminals full size).
  syncTab(tabId, root, enabled) {
    if (!tabId) return;
    const now = this.current(root), all = shared("tab.panels") ?? {};
    const same = (a, b) => Object.keys(now).every(k => (a[k] ?? null) === (b[k] ?? null));
    if (tabId !== this.tab) {
      const first = this.tab === undefined;
      this.tab = tabId; this.pending = null;
      if (first && !(tabId in all)) return this.record(tabId, now, all);
      const stored = all[tabId] ?? { panel: null, editor: false, terminal: true };
      const want = { ...now, ...stored };
      if (want.panel && !enabled.includes(want.panel)) want.panel = null;
      if (want.editor === false && want.terminal === false) want.terminal = true;
      if (!same(want, now)) {
        this.pending = { want, until: Date.now() + 1000 };
        this.apply(want, now);
        return;
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (!same(this.pending.want, now) && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (!all[tabId] || !same(all[tabId], now)) this.record(tabId, now, all);
  }

  record(tabId, now, all) {
    // Forget tabs that are gone.
    const live = new Set(spaces().flatMap(sp => sp.tabs.map(x => x.id)));
    const next = Object.fromEntries(Object.entries(all).filter(([id]) => live.has(id)));
    next[tabId] = { ...(all[tabId] ?? {}), ...now };
    setShared("tab.panels", next);
  }

  // Which IDE the active tab's repo wants (cached per folder).
  ide(space, tabId) {
    const cwd = panes().find(x => x.tab === tabId && x.terminal && x.cwd)?.cwd ?? space?.folder;
    if (!cwd || space?.machine || window()?.platform !== "macos") return null;
    this.ides ??= {};
    if (!(cwd in this.ides)) {
      this.ides[cwd] = null;
      const script = `top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null || echo "$1"); cd "$top" || exit 1
x=$(find . -maxdepth 3 -name '*.xcworkspace' -not -path '*.xcodeproj/*' -not -path '*/Pods/*' -not -path '*/.build/*' -not -path '*/node_modules/*' 2>/dev/null | head -1)
[ -z "$x" ] && x=$(find . -maxdepth 3 -name '*.xcodeproj' -not -path '*/Pods/*' -not -path '*/node_modules/*' 2>/dev/null | head -1)
[ -z "$x" ] && [ -f Package.swift ] && x=Package.swift
a=""; for f in settings.gradle settings.gradle.kts build.gradle build.gradle.kts; do [ -f "$f" ] && a=1; done
printf '%s\n%s\n%s\n' "$top" "$x" "$a"`;
      exec("sh", ["-c", script, "ide", cwd], { timeout: 10000 }).then((r) => {
        const [top, xcode, android] = r.stdout.split("\n");
        this.ides[cwd] = { top, xcode: xcode ? `${top}/${xcode.replace(/^\.\//, "")}` : null, android: android ? top : null };
        this.notifyLater = true;
      }).catch(() => {});
    }
    return this.ides[cwd];
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"])];
    // Coding's History panel, when this layout has one.
    if (find(root, "history")) enabled.push("history");
    this.syncTab(selected, root, enabled);
    const ide = this.ide(space, selected);
    const openIn = (app, path) => exec("open", ["-a", app, path]).then(r => { if (r.code !== 0) notify({ title: `Couldn't open ${app}`, body: r.stderr.trim(), level: "error" }); });
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    // Coding layout: the "code" column holds the editor and the terminals ("main").
    const code = find(root, "code"), editor = find(root, "editor"), term = find(root, "main");
    const termAbove = code?.children?.[0]?.id === "main";
    const viewButton = (id, label, on, action) => h_flex().id(`view-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
      .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover(s => s.bg(t.hover)).on_mouse_down("left", stop).on_click(action).child(label);
    const swap = () => {
      const tree = JSON.parse(JSON.stringify(root)), col = find(tree, "code");
      if (!col) return;
      col.children = [...col.children].reverse();
      run("layout.set", { layout: tree });
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(enabled.includes("history"), el => el.child(panelButton("history", "History", "mods/workspace-chrome/clock.svg")))
      .when(Boolean(ide?.xcode || ide?.android), el => el.child(div().w(1).h(16).mx(4).bg(t.border)))
      .when(Boolean(ide?.xcode), el => el.child(h_flex().id("open-xcode").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12).text_color(t.muted)
        .hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop).on_click(() => openIn("Xcode", ide.xcode))
        .child(svg("icons/swift.svg").size(13)).child("Xcode")))
      .when(Boolean(ide?.android), el => el.child(h_flex().id("open-android").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12).text_color(t.muted)
        .hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop).on_click(() => openIn("Android Studio", ide.android))
        .child(svg("icons/kotlin.svg").size(13)).child("Android Studio")))
      .when(Boolean(code), el => el
        .child(div().w(1).h(16).mx(4).bg(t.border))
        .child(viewButton("editor", "Editor", editor && !editor.hidden, () => {
          run("layout.toggle", { id: "editor" });
          // Shown empty: open its file search (it hides again when its last file closes).
          if (editor?.hidden) setShared("editor.open", { find: true, n: Date.now() });
        }))
        .child(viewButton("terminal", "Terminal", term && !term.hidden, () => run("layout.toggle", { id: "main" })))
        .child(viewButton("swap", termAbove ? "⇩ Terminal below" : "⇧ Terminal above", false, swap)))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/coding-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/coding-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/coding-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
