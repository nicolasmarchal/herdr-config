// Feeds the HerdrIsland notch app (island/ in this folder): writes the live agent
// list to island/state.json whenever it changes, and { closed: true } when Herdr
// quits. Shown as an "Island" chip in the status bar: click to start or quit the app.
// Herdr starts the app with itself unless it was quit from the chip (shared "island.autostart").
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, theme, appHome, exec, home, shared, setShared } from "herdr";
import * as fs from "fs/promises";

const ORDER = { blocked: 0, done: 1, working: 2, idle: 3 };
const APP = () => `${home()}/Applications/HerdrIsland.app`;

export default class Island extends View {
  init(_props, cx) {
    this.file = `${appHome()}/island/state.json`;
    this.last = null; this.running = false;
    this.checkRunning(cx, shared("island.autostart") !== false);
    cx.timer.every(5000, (cx) => this.checkRunning(cx));
  }

  checkRunning(cx, start = false) {
    cx.spawn(async (cx) => {
      const r = await exec("pgrep", ["-x", "HerdrIsland"]).catch(() => null);
      let running = r?.code === 0;
      if (!running && start) running = (await exec("open", ["-g", APP()]).catch(() => null))?.code === 0;
      if (running !== this.running) { this.running = running; cx.notify(); }
    });
  }

  snapshot() {
    const t = theme(), base = appHome();
    const list = agents().map((a) => ({
      address: a.address, status: a.status, seq: a.seq,
      name: a.program?.name ?? a.app ?? "Agent",
      icon: a.program?.icon ? `${base}/${a.program.icon}` : null, tint: !!a.program?.tint,
      tile: a.program?.tile ?? null,
      space: a.space, spaceName: a.space_name, tab: a.tab,
      tabName: /^(tb[0-9a-f]+|\d+)$/.test(a.tab_name ?? "") ? `Tab ${a.tab_index}` : a.tab_name,
      title: a.title, focused: a.focused,
    })).sort((x, y) => (ORDER[x.status] - ORDER[y.status]) || (y.seq - x.seq));
    return {
      closed: false,
      agents: list,
      colors: { working: t.working, blocked: t.blocked, done: t.done, idle: t.idle, accent: t.accent,
        foreground: t.foreground, muted: t.muted, dim: t.dim },
    };
  }

  publish(cx) {
    const json = JSON.stringify(this.snapshot());
    if (json === this.last) return;
    this.last = json;
    cx.spawn(async () => {
      try {
        await fs.mkdir(`${appHome()}/island`, { recursive: true });
        await fs.writeFile(this.file, json);
      } catch (e) { console.log(`island: ${e}`); }
    });
  }

  toggle(cx) {
    const start = !this.running;
    setShared("island.autostart", start);
    cx.spawn(async (cx) => {
      if (start) await exec("open", [APP()]).catch(() => null);
      else await exec("osascript", ["-e", 'quit app "HerdrIsland"']).catch(() => null);
      this.checkRunning(cx);
    });
  }

  render(cx) {
    this.publish(cx);
    const t = theme();
    return h_flex().size_full().items_center().justify_end().pr(4).bg(t.chrome).border_t(1).border_color(t.border)
      .child(h_flex().id("island-chip").h(20).px(8).gap(5).items_center().rounded(5).text_size(11.5).cursor_pointer()
        .text_color(this.running ? t.muted : t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.toggle(cx))
        .child(div().size(7).rounded(4).bg(this.running ? t.done : t.dim))
        .child("Island"));
  }

  async close() {
    try { await fs.writeFile(this.file, JSON.stringify({ closed: true, agents: [] })); } catch {}
  }
}
