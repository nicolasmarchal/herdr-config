// A Zed-style editor pane: fuzzy file finder (cmd-p), open-file tabs, editable
// code view with syntax highlighting, cmd-s to save, cmd-w to close a file.
// Open it beside a terminal with cmd-e (pane.split {mod: "editor"}), or pass
// props {root?, file?} to open a folder / file directly.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState } from "gpui-base";
import { panes, spaces, focused, exec, readTextFile, writeTextFile, theme, settings, props, nextCommand, notify } from "herdr";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", yml: "yaml", jsonc: "json", svelte: "html", vue: "html", htm: "html", md: "markdown", rs: "rust", py: "python", sh: "bash", zsh: "bash" };
const MAX_FILES = 20000, MAX_RESULTS = 60;

function score(query, path) {
  // Subsequence match; bonus for contiguous runs, word starts and basename hits.
  const q = query.toLowerCase(), p = path.toLowerCase(), base = p.lastIndexOf("/") + 1;
  let s = 0, j = 0, run = 0;
  for (let i = 0; i < p.length && j < q.length; i++) {
    if (p[i] !== q[j]) { run = 0; continue; }
    run++; j++;
    s += 1 + run * 2 + (i === 0 || "/_-. ".includes(p[i - 1]) ? 4 : 0) + (i >= base ? 3 : 0);
  }
  return j === q.length ? s - path.length * 0.02 : -1;
}

export default class ZedEditor extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.on = null;
    this.files = []; this.listed = false;
    this.tabs = []; this.active = -1;
    this.query = InputState.new({ placeholder: "Search files by name…" });
    this.query.on("change", (_e, cx) => { this.at = 0; cx.notify(); });
    this.query.on("submit", (_e, cx) => { this.pick(cx); });
    this.handle = cx.focus_handle();
    this.at = 0; this.finding = false;
    cx.spawn(async (cx) => {
      this.root = await this.findRoot(p.root);
      this.restore(p.file, cx);
      await this.listFiles();
      if (!this.tabs.length) this.openFinder();
      cx.notify();
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "save") this.save(cx);
        else if (c === "find") this.finding ? this.closeFinder() : this.openFinder();
        else if (c === "close_file") this.closeTab(this.active, cx);
        else if (c === "next_file" && this.tabs.length) this.active = (this.active + 1) % this.tabs.length;
        else if (c === "prev_file" && this.tabs.length) this.active = (this.active + this.tabs.length - 1) % this.tabs.length;
        else if (c === "zed") this.openInZed();
        else if (c === "focus" && this.finding) this.query.focus();
        cx.notify();
      }
    });
  }

  async findRoot(given) {
    let cwd = given;
    if (!cwd) {
      const me = panes().find(x => x.pane === props()?.pane) ?? null;
      const tab = me?.tab ?? focused()?.tab;
      cwd = panes().find(x => x.tab === tab && x.cwd)?.cwd ?? focused()?.cwd ?? spaces().find(s => s.active)?.folder;
      const space = spaces().find(s => s.tabs?.some?.(t => t.id === tab)) ?? spaces().find(s => s.active);
      this.on = space?.machine ?? null;
    }
    if (!cwd) return null;
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on: this.on }).catch(() => null);
    return top?.code === 0 ? top.stdout.trim() : cwd;
  }

  async listFiles() {
    if (!this.root) return;
    const opt = { cwd: this.root, on: this.on, timeout: 15000 };
    let r = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], opt).catch(() => null);
    if (r?.code !== 0) r = await exec("sh", ["-c", "find . -type d \\( -name .git -o -name node_modules -o -name target -o -name dist \\) -prune -o -type f -print0 | head -c 4000000"], opt).catch(() => null);
    this.files = (r?.stdout ?? "").split("\0").filter(Boolean).map(f => f.replace(/^\.\//, "")).slice(0, MAX_FILES);
    this.listed = true;
  }

  restore(file, cx) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem("editor") ?? "null"); } catch {}
    const list = saved?.root === this.root ? saved.files ?? [] : [];
    for (const f of list) this.open(f, cx, false);
    if (saved?.root === this.root && saved.active >= 0) this.active = Math.min(saved.active, this.tabs.length - 1);
    if (file) this.open(file.startsWith("/") && this.root && file.startsWith(this.root + "/") ? file.slice(this.root.length + 1) : file, cx);
  }

  persist() {
    try { localStorage.setItem("editor", JSON.stringify({ root: this.root, files: this.tabs.map(t => t.path), active: this.active })); } catch {}
  }

  abs(path) { return path.startsWith("/") ? path : `${this.root}/${path}`; }

  open(path, cx, focus = true) {
    const existing = this.tabs.findIndex(t => t.path === path);
    if (existing >= 0) { if (focus) this.active = existing; this.persist(); return; }
    const tab = { path, state: null, saved: null, dirty: false, error: null };
    this.tabs.push(tab);
    if (focus || this.active < 0) this.active = this.tabs.length - 1;
    this.persist();
    this.load(tab, cx);
  }

  load(tab, cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(this.abs(tab.path), { on: this.on });
        if (text === null) tab.error = "File not found";
        else if (text.includes("\0")) tab.error = "Binary file";
        else {
          const t = theme(), name = tab.path.split("/").pop(), ext = name.includes(".") ? name.split(".").pop().toLowerCase() : name;
          tab.state?.release();
          tab.saved = text; tab.dirty = false; tab.error = null;
          tab.state = EditorState.new({
            language: LANG[ext] ?? ext, value: text, readonly: this.on !== null,
            font_family: settings().font_family, font_size: 13,
            syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, boolean: t.ansi6, "string.escape": t.ansi6 },
          });
          tab.state.on("change", (_e, cx) => {
            const dirty = tab.state.value() !== tab.saved;
            if (dirty !== tab.dirty) { tab.dirty = dirty; cx.notify(); }
          });
        }
      } catch (e) { tab.error = "Cannot open: too large (over 1 MiB) or unreadable"; }
      cx.notify();
    });
  }

  save(cx) {
    const tab = this.tabs[this.active];
    if (!tab?.state || !tab.dirty) return;
    if (this.on !== null) return notify({ title: "Read-only", body: "Files on other machines can't be saved from the editor yet.", level: "warning" });
    const text = tab.state.value();
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(this.abs(tab.path), text, tab.saved);
        tab.saved = text; tab.dirty = tab.state.value() !== text; tab.conflict = false;
      } catch (e) {
        tab.conflict = true;
        notify({ title: `Couldn't save ${tab.path.split("/").pop()}`, body: "It changed on disk since you opened it. Reload it or copy your changes first.", level: "error" });
      }
      cx.notify();
    });
  }

  closeTab(i, cx) {
    const tab = this.tabs[i];
    if (!tab) return;
    if (tab.dirty && !tab.confirmClose) {
      tab.confirmClose = true;
      notify({ title: "Unsaved changes", body: `${tab.path.split("/").pop()} has unsaved changes. Close again to discard them.`, level: "warning", timeout: 4000 });
      return;
    }
    tab.state?.release();
    this.tabs.splice(i, 1);
    if (this.active >= this.tabs.length) this.active = this.tabs.length - 1;
    else if (i < this.active) this.active--;
    this.persist();
    if (!this.tabs.length) this.openFinder();
    cx?.notify();
  }

  openFinder() { this.finding = true; this.at = 0; this.query.set_value(""); this.query.focus(); }
  closeFinder() { this.finding = false; }

  results() {
    const q = this.query.value().trim();
    if (!q) {
      const openSet = new Set(this.tabs.map(t => t.path));
      return this.files.filter(f => !openSet.has(f)).slice(0, MAX_RESULTS);
    }
    const scored = [];
    for (const f of this.files) { const s = score(q.replace(/\s+/g, ""), f); if (s >= 0) scored.push([s, f]); }
    return scored.sort((a, b) => b[0] - a[0]).slice(0, MAX_RESULTS).map(x => x[1]);
  }

  pick(cx) {
    const r = this.results();
    const path = r[Math.min(this.at, r.length - 1)];
    if (!path) return;
    this.finding = false;
    this.open(path, cx);
    cx.notify();
  }

  openInZed() {
    const tab = this.tabs[this.active];
    const target = tab ? this.abs(tab.path) : this.root;
    if (!target || this.on !== null) return;
    exec("open", ["-a", "Zed", target]).catch(() => notify({ title: "Zed not found", level: "error" }));
  }

  finder(t) {
    const r = this.results();
    if (this.at >= r.length) this.at = Math.max(0, r.length - 1);
    return v_flex().id("finder").absolute().top(8).left(0).right(0).mx_auto().w(560).max_w_full().max_h(420)
      .rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg().overflow_hidden()
      .on_key_down((e, cx) => {
        if (e.key === "escape") { if (this.tabs.length) this.closeFinder(); }
        else if (e.key === "down") this.at = Math.min(this.at + 1, r.length - 1);
        else if (e.key === "up") this.at = Math.max(this.at - 1, 0);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().h(38).flex_none().px(12).items_center().border_b(1).border_color(t.border)
        .child(Input.new(this.query).flex_1().h_full().text_size(13).text_color(t.foreground)))
      .child(v_flex().id("finder-list").max_h(380).overflow_y_scrollbar().p(4).children(
        r.map((f, i) => {
          const slash = f.lastIndexOf("/");
          return h_flex().id(`fr-${f}`).h(26).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
            .when(i === this.at, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { this.at = i; this.pick(cx); })
            .child(div().min_w(0).truncate().text_color(t.foreground).child(f.slice(slash + 1)))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(slash > 0 ? f.slice(0, slash) : ""));
        }))
        .when(!r.length, el => el.child(div().p(10).text_size(12).text_color(t.dim).child(this.listed ? (this.root ? "No matching files" : "No folder") : "Indexing files…"))));
  }

  render(cx) {
    const t = theme(), tab = this.tabs[this.active];
    const rootName = this.root?.split("/").pop() ?? "";
    return v_flex().id("editor-root").size_full().min_h(0).relative().bg(t.background).text_color(t.foreground).text_size(12)
      .track_focus(this.handle)
      // Tab bar
      .child(h_flex().id("editor-tabs").h(32).flex_none().bg(t.chrome).border_b(1).border_color(t.border).overflow_x_scroll()
        .children(this.tabs.map((x, i) => {
          const on = i === this.active, name = x.path.split("/").pop();
          return h_flex().id(`tab-${x.path}`).h_full().flex_none().pl(12).pr(6).gap(6).items_center().cursor_pointer()
            .border_r(1).border_color(t.border).when(on, el => el.bg(t.background)).hover(s => s.bg(on ? t.background : t.hover))
            .on_click((_e, cx) => { this.active = i; this.finding = false; this.persist(); cx.notify(); })
            .child(div().text_color(on ? t.foreground : t.muted).child(name))
            .child(div().id(`tabx-${x.path}`).w(16).h(16).flex().items_center().justify_center().rounded(4).text_size(11)
              .text_color(x.dirty ? t.accent : t.dim).hover(s => s.bg(t.raised).text_color(t.foreground))
              .on_click((_e, cx) => { cx.stop_propagation(); this.closeTab(i, cx); })
              .child(x.dirty ? "●" : "✕"));
        }))
        .child(div().flex_1())
        .child(div().id("editor-find").px(10).h_full().flex().items_center().cursor_pointer().text_color(t.muted).hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.finding ? this.closeFinder() : this.openFinder(); cx.notify(); }).child("⌘P")))
      // Body
      .child(div().flex_1().min_h(0).flex().flex_col()
        .child(tab?.state ? Editor.new(tab.state).flex_1().min_h(0)
          : v_flex().flex_1().items_center().justify_center().gap(6).text_color(t.dim)
              .child(div().text_size(14).child(tab?.error ?? (tab ? "Loading…" : rootName || "Editor")))
              .when(!tab, el => el.child(div().child("⌘P open file  ·  ⌘S save  ·  ⌘W close file")))))
      // Status bar
      .child(h_flex().h(24).flex_none().px(10).gap(10).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(tab ? `${rootName}/${tab.path}` : this.root ?? ""))
        .when(Boolean(tab?.conflict), el => el.child(div().id("editor-reload").text_color(t.blocked).cursor_pointer().hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => { tab.conflict = false; this.load(tab, cx); }).child("Changed on disk · Reload")))
        .when(Boolean(tab?.dirty), el => el.child(div().text_color(t.accent).child("Modified")))
        .when(this.on !== null, el => el.child(div().child("Read-only (remote)")))
        .when(this.on === null && Boolean(this.root), el => el.child(div().id("editor-zed").cursor_pointer().hover(s => s.text_color(t.foreground))
          .on_click(() => this.openInZed()).child("Open in Zed"))))
      .when(this.finding, el => el.child(div().absolute().top(32).left(0).right(0).bottom(24).px(12).child(this.finder(t))));
  }

  close() {
    for (const tab of this.tabs) tab.state?.release();
  }
}
