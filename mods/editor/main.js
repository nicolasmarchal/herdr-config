// A Zed-style editor pane: fuzzy file finder (cmd-p), open-file tabs, editable
// code view with syntax highlighting, cmd-s to save, cmd-w to close a file.
// Open it beside a terminal with cmd-e (pane.split {mod: "editor"}), or pass
// props {root?, file?} to open a folder / file directly, or {follow: true} in a
// layout block (Coding layout): follows the active tab (each Herdr tab keeps its
// own open files), opens shared "editor.open" { path, n, diff? }. Files opened
// with diff: true get Changes / Old / New views; with commit: <sha> they show that
// commit's change to the file (Old: before it, New: as of it, read-only).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState, Scrollbar, v_virtual_list } from "gpui-base";
import { panes, spaces, focused, exec, readTextFile, writeTextFile, theme, settings, props, nextCommand, notify, shared, run } from "herdr";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", yml: "yaml", jsonc: "json", svelte: "html", vue: "html", htm: "html", md: "markdown", rs: "rust", py: "python", sh: "bash", zsh: "bash" };
const MAX_FILES = 20000, MAX_RESULTS = 60, OPEN = "editor.open";
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const VIEWS = [["changes", "Changes"], ["old", "Old"], ["new", "New"]];

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Unified diff lines -> rows with old and new line numbers.
function diffRows(lines) {
  let a = 0, b = 0;
  return lines.map((line) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { a = +m[1]; b = +m[2]; return { kind: "@", text: line }; }
    const k = line[0], text = untab(line.slice(1)) || " ";
    if (k === "-") return { kind: k, old: a++, text };
    if (k === "+") return { kind: k, new: b++, text };
    if (k === " ") return { kind: k, old: a++, new: b++, text };
    return { kind: "", text: line };
  });
}

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
    // follow: lives in a layout block, tracks the active space and opens what
    // other mods send with setShared("editor.open", { path, n }).
    this.follow = Boolean(p.follow);
    this.on = null; this.root = null; this.key = null; this.tracked = null;
    this.files = []; this.listed = false;
    this.tabs = []; this.active = -1;
    this.sessions = {}; this.fileCache = {};
    this.seenOpen = shared(OPEN)?.n ?? 0;
    this.query = InputState.new({ placeholder: "Search files by name…" });
    this.query.on("change", (_e, cx) => { this.at = 0; cx.notify(); });
    this.query.on("submit", (_e, cx) => { this.pick(cx); });
    this.handle = cx.focus_handle();
    this.at = 0; this.finding = false;
    if (!this.follow) cx.spawn(async (cx) => {
      await this.setRoot(await this.findRoot(p.root), cx);
      if (p.file) this.openPath(p.file, cx, p.view ?? (p.commit ? "changes" : null), p.commit ?? null);
      if (!this.tabs.length) this.openFinder();
      cx.notify();
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "save") this.save(cx);
        else if (c === "find") this.finding ? this.closeFinder() : this.openFinder();
        else if (c === "close_file") this.closeTab(this.active, cx);
        else if (c === "next_file" && this.tabs.length) { this.active = (this.active + 1) % this.tabs.length; this.persist(); }
        else if (c === "prev_file" && this.tabs.length) { this.active = (this.active + this.tabs.length - 1) % this.tabs.length; this.persist(); }
        else if (c === "zed") this.openInZed();
        else if (c === "focus" && this.finding) this.query.focus();
        cx.notify();
      }
    });
  }

  // Follow mode: each Herdr tab has its own session (root, open files), and
  // the root follows where the tab's first terminal is (a cd into a worktree).
  track(cx) {
    const space = spaces().find(s => s.active), tab = space?.tabs?.find(t => t.active);
    if (!tab) return;
    const cwd = panes().find(x => x.tab === tab.id && x.terminal && x.cwd)?.cwd ?? space.folder;
    const key = `${tab.id}|${cwd}`;
    if (key === this.tracked) return;
    this.tracked = key;
    cx.spawn(async (cx) => {
      const found = await this.findRoot(cwd, space);
      if (this.tracked !== key) return;
      await this.setRoot(found, cx, tab.id);
      this.drain(cx);
      cx.notify();
    });
  }

  // Opens a file another mod asked for (shared "editor.open").
  drain(cx) {
    const req = shared(OPEN);
    if (!req?.n || req.n <= this.seenOpen || !this.root) return;
    this.seenOpen = req.n;
    if (req.find) { if (!this.tabs.length) this.openFinder(); return; }
    this.openPath(req.path, cx, req.diff || req.commit ? "changes" : null, req.commit ?? null);
  }

  async findRoot(given, space) {
    let cwd = given, on = space?.machine ?? null;
    if (!cwd) {
      let tab;
      if (space) tab = space.tabs?.find(t => t.active)?.id;
      else {
        tab = panes().find(x => x.pane === props()?.pane)?.tab ?? focused()?.tab;
        space = spaces().find(s => s.tabs?.some(t => t.id === tab)) ?? spaces().find(s => s.active);
      }
      cwd = panes().find(x => x.tab === tab && x.terminal && x.cwd)?.cwd ?? space?.folder;
      on = space?.machine ?? null;
    }
    if (!cwd) return { root: null, on };
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
    return { root: top?.code === 0 ? top.stdout.trim() : cwd, on };
  }

  async setRoot({ root, on }, cx, key = `${on}:${root}`) {
    if (key === this.key && root === this.root && on === this.on) return;
    if (this.key) this.sessions[this.key] = { root: this.root, on: this.on, tabs: this.tabs, active: this.active };
    this.finding = false;
    const kept = this.sessions[key];
    this.key = key;
    delete this.sessions[key];
    if (kept && kept.root === root && kept.on === on) Object.assign(this, kept);
    else {
      for (const tab of kept?.tabs ?? []) this.release(tab);
      this.root = root; this.on = on; this.tabs = []; this.active = -1;
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(`editor:${key}`) ?? "null"); } catch {}
      if (saved?.root === root) {
        for (const f of saved.files ?? []) this.open(typeof f === "string" ? f : f.path, cx, false, f.view ?? null, f.commit ?? null);
        if (saved.active >= 0) this.active = Math.min(saved.active, this.tabs.length - 1);
      }
    }
    const cached = this.fileCache[`${on}:${root}`];
    if (cached) { this.files = cached; this.listed = true; }
    else { this.files = []; this.listed = false; await this.listFiles(); }
  }

  async listFiles() {
    if (!this.root) return;
    const root = this.root, opt = { cwd: root, on: this.on, timeout: 15000 };
    let r = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], opt).catch(() => null);
    if (r?.code !== 0) r = await exec("sh", ["-c", "find . -type d \\( -name .git -o -name node_modules -o -name target -o -name dist \\) -prune -o -type f -print0 | head -c 4000000"], opt).catch(() => null);
    if (this.root !== root) return;
    this.files = this.fileCache[`${this.on}:${root}`] = (r?.stdout ?? "").split("\0").filter(Boolean).map(f => f.replace(/^\.\//, "")).slice(0, MAX_FILES);
    this.listed = true;
  }

  persist() {
    if (!this.key) return;
    try { localStorage.setItem(`editor:${this.key}`, JSON.stringify({ root: this.root, files: this.tabs.map(t => ({ path: t.path, view: t.view, commit: t.commit })), active: this.active })); } catch {}
  }

  openPath(path, cx, view = null, commit = null) {
    if (!path) return;
    this.finding = false;
    this.open(this.root && path.startsWith(this.root + "/") ? path.slice(this.root.length + 1) : path, cx, true, view, commit);
  }

  abs(path) { return path.startsWith("/") ? path : `${this.root}/${path}`; }

  open(path, cx, focus = true, view = null, commit = null) {
    const existing = this.tabs.findIndex(t => t.path === path && (t.commit ?? null) === commit);
    if (existing >= 0) {
      const tab = this.tabs[existing];
      if (focus) this.active = existing;
      if (view) this.setView(tab, view, cx);
      this.persist(); return;
    }
    const tab = { path, state: null, saved: null, dirty: false, error: null, view: null, commit };
    this.tabs.push(tab);
    if (focus || this.active < 0) this.active = this.tabs.length - 1;
    this.persist();
    this.load(tab, cx);
    if (view) this.setView(tab, view, cx);
  }

  release(tab) { tab.state?.release(); tab.oldState?.release(); }

  // Changes (diff against HEAD) / Old (HEAD's version) / New (the file, editable).
  setView(tab, view, cx) {
    tab.view = view;
    this.persist();
    if (view === "changes") this.loadDiff(tab, cx);
    if (view === "old" && !tab.oldState && !tab.oldError) this.loadOld(tab, cx);
  }

  language(path) {
    const name = path.split("/").pop(), ext = name.includes(".") ? name.split(".").pop().toLowerCase() : name;
    return LANG[ext] ?? ext;
  }

  syntax() {
    const t = theme();
    return { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, boolean: t.ansi6, "string.escape": t.ansi6 };
  }

  loadDiff(tab, cx) {
    const root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      const git = (args) => exec("git", [...READ, ...args], { cwd: root, on }).catch(() => null);
      let lines;
      const tracked = tab.commit ? null : await git(["ls-files", "--error-unmatch", "--", tab.path]);
      if (tab.commit) {
        // What that commit did to the file (against its first parent; the first commit: everything).
        const r = await git(["show", "--format=", "--no-ext-diff", "--no-color", "--first-parent", tab.commit, "--", tab.path]);
        const all = (r?.stdout ?? "").replace(/\n$/, "").split("\n"), first = all.findIndex(l => l.startsWith("@@"));
        lines = first < 0 ? [r?.stdout?.includes("Binary") ? "Binary file changed" : "No text change in this commit"] : all.slice(first);
      } else if (tracked?.code !== 0) {
        const text = await readTextFile(`${root}/${tab.path}`, { on }).catch(() => null);
        lines = text === null ? ["File not found"] : text.includes("\0") ? ["Binary file"]
          : [`@@ -0,0 +1 @@ new file`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").map(l => `+${l}`)];
      } else {
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const r = await git(["diff", ...(head?.code === 0 ? ["HEAD"] : ["--cached"]), "--no-ext-diff", "--no-color", "--", tab.path]);
        const all = (r?.stdout ?? "").replace(/\n$/, "").split("\n"), first = all.findIndex(l => l.startsWith("@@"));
        lines = first < 0 ? [r?.stdout?.includes("Binary") ? "Binary file changed" : "No changes against HEAD"] : all.slice(first);
      }
      tab.diff = diffRows(lines.slice(0, 5000).map(l => l.length > 4000 ? l.slice(0, 4000) + "…" : l));
      tab.diffWidth = Math.max(300, ...tab.diff.map(r => (r.text.length + 1) * 7.5 + 90));
      cx.notify();
    });
  }

  loadOld(tab, cx) {
    const root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      const before = tab.commit ? `${tab.commit}^` : "HEAD";
      const r = await exec("git", [...READ, "show", `${before}:${tab.path}`], { cwd: root, on }).catch(() => null);
      if (r?.code !== 0) tab.oldError = tab.commit ? "Added in this commit · no previous version" : "New file · no previous version";
      else if (r.stdout.includes("\0")) tab.oldError = "Binary file";
      else tab.oldState = EditorState.new({ language: this.language(tab.path), value: r.stdout, readonly: true,
        font_family: settings().font_family, font_size: 13, syntax: this.syntax() });
      cx.notify();
    });
  }

  diffRow(r, t) {
    const num = (n) => div().w(38).flex_none().pr(6).text_right().text_color(t.dim).child(n === undefined ? "" : String(n));
    if (r.kind === "@") return h_flex().w_full().h(20).flex_none().px(10).items_center().bg(t.raised).text_color(t.dim).child(div().truncate().child(r.text));
    return h_flex().w_full().h(20).flex_none().items_center()
      .when(r.kind === "+", e => e.bg(t.ansi2 + "22")).when(r.kind === "-", e => e.bg(t.ansi1 + "22"))
      .child(num(r.old)).child(num(r.new))
      .child(div().w(14).flex_none().text_color(r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.dim).child(r.kind === "+" || r.kind === "-" ? r.kind : ""))
      .child(div().flex_1().whitespace_nowrap().child(r.text));
  }

  diffView(tab, t) {
    const rows = tab.diff;
    if (!rows) return div().flex_1().p(12).text_color(t.dim).child("Loading changes…");
    const id = `ed-diff-${this.key}-${tab.path}@${tab.commit ?? ""}`;
    return div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
      .child(div().id(`${id}-x`).size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(tab.diffWidth).h_full().child(v_virtual_list(id, rows.length, 20, (i) => String(i),
          (range) => rows.slice(range.start, range.end).map((r) => this.diffRow(r, t))).size_full())))
      .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0());
  }

  load(tab, cx) {
    cx.spawn(async (cx) => {
      try {
        const text = tab.commit
          ? await exec("git", [...READ, "show", `${tab.commit}:${tab.path}`], { cwd: this.root, on: this.on })
              .then(r => r.code === 0 ? r.stdout : null).catch(() => null)
          : await readTextFile(this.abs(tab.path), { on: this.on });
        if (text === null) tab.error = tab.commit ? "Deleted in this commit" : "File not found";
        else if (text.includes("\0")) tab.error = "Binary file";
        else {
          tab.state?.release();
          tab.saved = text; tab.dirty = false; tab.error = null;
          tab.state = EditorState.new({
            language: this.language(tab.path), value: text, readonly: this.on !== null || Boolean(tab.commit),
            font_family: settings().font_family, font_size: 13, syntax: this.syntax(),
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
        if (tab.view) this.loadDiff(tab, cx);
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
    this.release(tab);
    this.tabs.splice(i, 1);
    if (this.active >= this.tabs.length) this.active = this.tabs.length - 1;
    else if (i < this.active) this.active--;
    this.persist();
    if (!this.tabs.length && !this.follow) this.openFinder();
    // In the Coding layout the editor goes away with its last file.
    if (!this.tabs.length && this.follow) run("layout.hide", { id: "editor" });
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
    if (this.follow) { this.track(cx); this.drain(cx); }
    const t = theme(), tab = this.tabs[this.active];
    const rootName = this.root?.split("/").pop() ?? "";
    return v_flex().id("editor-root").size_full().min_h(0).relative().bg(t.background)
      .when(this.follow, el => el.rounded(10).overflow_hidden().border_1().border_color(t.border)).text_color(t.foreground).text_size(12)
      .track_focus(this.handle)
      // Tab bar
      .child(h_flex().id("editor-tabs").h(32).flex_none().bg(t.chrome).border_b(1).border_color(t.border).overflow_x_scroll()
        .children(this.tabs.map((x, i) => {
          const on = i === this.active, name = x.path.split("/").pop();
          return h_flex().id(`tab-${x.path}@${x.commit ?? ""}`).h_full().flex_none().pl(12).pr(6).gap(6).items_center().cursor_pointer()
            .border_r(1).border_color(t.border).when(on, el => el.bg(t.background)).hover(s => s.bg(on ? t.background : t.hover))
            .on_click((_e, cx) => { this.active = i; this.finding = false; this.persist(); cx.notify(); })
            .child(div().text_color(on ? t.foreground : t.muted).child(name))
            .when(Boolean(x.commit), el => el.child(div().px(4).rounded(3).bg(t.raised).text_size(10).text_color(t.muted).child(x.commit?.slice(0, 7) ?? "")))
            .child(div().id(`tabx-${x.path}@${x.commit ?? ""}`).w(16).h(16).flex().items_center().justify_center().rounded(4).text_size(11)
              .text_color(x.dirty ? t.accent : t.dim).hover(s => s.bg(t.raised).text_color(t.foreground))
              .on_click((_e, cx) => { cx.stop_propagation(); this.closeTab(i, cx); })
              .child(x.dirty ? "●" : "✕"));
        }))
        .child(div().flex_1())
        .when(Boolean(tab?.view), el => el.child(h_flex().flex_none().mr(6).p(2).gap(2).rounded(6).bg(t.background).border_1().border_color(t.border)
          .children(VIEWS.map(([v, label]) => div().id(`view-${v}`).px(8).h(20).flex().items_center().rounded(4).text_size(11).cursor_pointer()
            .bg(tab.view === v ? t.selected : t.background).text_color(tab.view === v ? t.foreground : t.muted).hover(s => s.text_color(t.foreground))
            .on_click((_e, cx) => { this.setView(tab, v, cx); cx.notify(); }).child(label)))))
        .child(div().id("editor-find").px(10).h_full().flex().items_center().cursor_pointer().text_color(t.muted).hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.finding ? this.closeFinder() : this.openFinder(); cx.notify(); }).child("⌘P")))
      // Body
      .child(div().flex_1().min_h(0).flex().flex_col()
        .child(tab?.view === "changes" ? this.diffView(tab, t)
          : tab?.view === "old" ? (tab.oldState ? Editor.new(tab.oldState).flex_1().min_h(0) : div().flex_1().p(12).text_color(t.dim).child(tab.oldError ?? "Loading…"))
          : tab?.state ? Editor.new(tab.state).flex_1().min_h(0)
          : v_flex().flex_1().items_center().justify_center().gap(6).text_color(t.dim)
              .child(div().text_size(14).child(tab?.error ?? (tab ? "Loading…" : rootName || "Editor")))
              .when(!tab, el => el.child(div().child("⌘P open file  ·  ⌘S save  ·  ⌘W close file")))))
      // Status bar
      .child(h_flex().h(24).flex_none().px(10).gap(10).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(tab ? `${rootName}/${tab.path}` : this.root ?? ""))
        .when(Boolean(tab?.commit), el => el.child(div().child(`commit ${tab.commit.slice(0, 7)} · read-only`)))
        .when(!tab?.commit && tab?.view === "old", el => el.child(div().child("HEAD · read-only")))
        .when(Boolean(tab?.conflict), el => el.child(div().id("editor-reload").text_color(t.blocked).cursor_pointer().hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => { tab.conflict = false; this.load(tab, cx); }).child("Changed on disk · Reload")))
        .when(Boolean(tab?.dirty), el => el.child(div().text_color(t.accent).child("Modified")))
        .when(this.on !== null, el => el.child(div().child("Read-only (remote)")))
        .when(this.on === null && Boolean(this.root), el => el.child(div().id("editor-zed").cursor_pointer().hover(s => s.text_color(t.foreground))
          .on_click(() => this.openInZed()).child("Open in Zed"))))
      .when(this.finding, el => el.child(div().absolute().top(32).left(0).right(0).bottom(24).px(12).child(this.finder(t))));
  }

  close() {
    for (const tab of this.tabs) this.release(tab);
    for (const s of Object.values(this.sessions)) for (const tab of s.tabs ?? []) this.release(tab);
  }
}
