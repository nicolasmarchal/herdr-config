// macOS notifications when an agent is blocked (needs you) or done (finished
// while you weren't looking). Skipped while Herdr is in front and showing that
// agent's tab. Clicking the notification goes to the agent.
// Shown as a bell chip in the status bar: click to turn alerts on/off
// (shared "agent-alerts.enabled").
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, spaces, shared, setShared, theme, exec, window } from "herdr";

const enabled = () => shared("agent-alerts.enabled") !== false;
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export default class AgentAlerts extends View {
  init(_props, cx) {
    // terminal-notifier (clickable, goes to the agent) if installed, else osascript.
    cx.spawn(async () => {
      const r = await exec("sh", ["-lc", "command -v terminal-notifier; command -v herdr-app"]).catch(() => null);
      [this.notifier, this.herdr] = (r?.stdout ?? "").split("\n");
    });
    // Seed with what's already there: only changes from now on alert.
    this.seen = Object.fromEntries(agents().map(a => [a.address, a.status]));
  }

  check() {
    const list = agents(), shownTab = spaces().find(s => s.active)?.tabs?.find(t => t.active)?.id;
    const front = window()?.active;
    for (const a of list) {
      const before = this.seen[a.address];
      this.seen[a.address] = a.status;
      if (before === undefined || before === a.status) continue;
      if (a.status !== "blocked" && a.status !== "done") continue;
      if (!enabled() || (front && a.tab === shownTab)) continue;
      this.post(a);
    }
    const live = new Set(list.map(a => a.address));
    for (const k of Object.keys(this.seen)) if (!live.has(k)) delete this.seen[k];
  }

  post(a) {
    const who = a.program?.name ?? a.app ?? "Agent";
    const title = `${who} · ${a.space_name}`;
    const message = a.status === "blocked" ? "Needs you" : "Finished";
    const subtitle = /^\d+$/.test(a.tab_name ?? "") || !a.tab_name ? `Tab ${a.tab_index}` : a.tab_name;
    const fallback = () => exec("osascript", ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} subtitle ${JSON.stringify(subtitle)}`]).catch(() => {});
    if (!this.notifier) return fallback();
    exec(this.notifier, ["-title", title, "-subtitle", subtitle, "-message", message, "-group", `herdr-${a.address}`,
      "-activate", "dev.herdr.app", "-execute", `${this.herdr || "herdr-app"} do agent.focus --terminal ${quote(a.address)}`])
      .catch(fallback);
  }

  render() {
    this.check();
    const t = theme(), on = enabled();
    return h_flex().size_full().items_center().justify_end().pr(4).bg(t.chrome).border_t(1).border_color(t.border)
      .child(h_flex().id("agent-alerts").h(20).px(8).gap(5).items_center().rounded(5).text_size(11.5).cursor_pointer()
        .text_color(on ? t.muted : t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { setShared("agent-alerts.enabled", !on); cx.notify(); })
        .child(on ? "🔔" : "🔕").child(on ? "Alerts" : "Alerts off"));
  }
}
