// One layout per space. Selecting a space switches to the layout it last used;
// switching layouts while in a space remembers it for that space.
// Shown as a chip in the status bar ("▦ Coding"); click it to pick this space's layout.
// Lives in every layout that should take part (standard, coding): a layout
// without this mod can't switch you back when you change space.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, shared, setShared, layouts, run, theme, props, openOverlay, closeOverlay } from "herdr";

const MAP = "space.layouts", STATE = "space.layouts.state", DEFAULT = "standard";
const NAMES = { standard: "Standard", coding: "Coding", main: "Herdr", terminals: "Terminals", win98: "Herdr 98" };
const label = (n) => NAMES[n] ?? n.replace(/[-_]/g, " ").replace(/^./, c => c.toUpperCase());

function check() {
  const space = spaces().find(s => s.active)?.id, current = shared("layout");
  if (!space || !current) return;
  const map = shared(MAP) ?? {}, state = shared(STATE) ?? {};
  if (state.pending) {
    // A switch we asked for is landing (this copy may be the new layout's).
    if (current === state.pending || Date.now() > state.until) setShared(STATE, { space: state.space });
    return;
  }
  if (space !== state.space) {
    // A space that never chose one gets the default layout.
    const want = map[space] ?? (layouts().includes(DEFAULT) ? DEFAULT : current);
    if (want !== current && layouts().includes(want)) {
      setShared(STATE, { space, pending: want, until: Date.now() + 3000 });
      run("layout.switch", { name: want });
    } else setShared(STATE, { space });
    return;
  }
  if (map[space] !== current) setShared(MAP, { ...map, [space]: current });
}

export default class SpaceLayouts extends View {
  init(_props, cx) {
    if (props()?.overlay) return;
    check();
    cx.timer.every(250, () => check());
  }

  render() {
    const t = theme(), current = shared("layout") ?? "";
    if (props()?.overlay) {
      // The picker popup.
      return v_flex().p(4).gap(1).text_size(12.5).text_color(t.foreground).children(layouts().map(name =>
        h_flex().id(`l-${name}`).h(28).px(10).gap(8).items_center().rounded(6).cursor_pointer().hover(s => s.bg(t.hover))
          .when(name === current, el => el.bg(t.selected))
          .on_click(() => { closeOverlay(props().overlay); if (name !== current) run("layout.switch", { name }); })
          .child(div().w(12).text_color(t.accent).child(name === current ? "✓" : ""))
          .child(div().flex_1().child(label(name)))));
    }
    const space = spaces().find(s => s.active);
    return h_flex().id("space-layout").size_full().justify_end().items_center().pr(10).bg(t.chrome).border_t(1).border_color(t.border)
      .child(h_flex().id("space-layout-chip").h(20).px(8).gap(6).items_center().rounded(5).text_size(11.5).text_color(t.muted).cursor_pointer()
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => openOverlay({ mod: "space-layouts", kind: "popup", width: 180, height: Math.min(40 + layouts().length * 29, 320) }))
        .child(div().text_color(t.dim).child(space ? `${space.name} ·` : ""))
        .child(div().child(`▦ ${label(current)}`)));
  }
}
