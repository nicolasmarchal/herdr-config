// HerdrIsland: Herdr's agents in the MacBook notch.
//
// Reads ~/.config/herdr-app/island/state.json (written by the `island` Herdr mod).
// At rest it hugs the notch: working agents on the left, agents that need you on
// the right. Hover to see every agent; click one to jump to it in Herdr. When an
// agent finishes or needs you, the island opens on it for a few seconds.
//
// Build: island/build.sh (installs ~/Applications/HerdrIsland.app).

import AppKit
import SwiftUI

// MARK: - Data

struct Agent: Codable, Identifiable, Equatable {
    var address: String
    var status: String
    var seq: Int
    var name: String
    var icon: String?
    var tint: Bool
    var tile: String?
    var space: String
    var spaceName: String
    var tab: String
    var tabName: String?
    var title: String?
    var focused: Bool
    var id: String { address }
}

struct Palette: Codable, Equatable {
    var working: String, blocked: String, done: String, idle: String
    var accent: String, foreground: String, muted: String, dim: String
}

struct Snapshot: Codable {
    var closed: Bool
    var agents: [Agent]
    var colors: Palette?
}

extension Color {
    init(hex: String?, fallback: Color = .gray) {
        guard var s = hex?.trimmingCharacters(in: .whitespaces), s.hasPrefix("#") else { self = fallback; return }
        s.removeFirst()
        if s.count == 6 { s += "ff" }
        guard s.count == 8, let v = UInt64(s, radix: 16) else { self = fallback; return }
        self = Color(.sRGB,
                     red: Double((v >> 24) & 0xff) / 255, green: Double((v >> 16) & 0xff) / 255,
                     blue: Double((v >> 8) & 0xff) / 255, opacity: Double(v & 0xff) / 255)
    }
}

// MARK: - Prompts (an agent waiting on a menu in its terminal)

struct Prompt: Equatable {
    var context: [String]   // what it's about: "Bash command", "touch hello.txt"
    var question: String    // "Do you want to proceed?"
    var options: [String]
    var cursor: Int         // the option the terminal's ❯ is on
}

enum Hc {
    static let path = ["\(NSHomeDirectory())/.local/bin/hc", "/opt/homebrew/bin/hc", "/usr/local/bin/hc"]
        .first { FileManager.default.isExecutableFile(atPath: $0) }

    static func run(_ args: [String]) -> String? {
        guard let path else { return nil }
        let p = Process(), out = Pipe()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return p.terminationStatus == 0 ? String(decoding: data, as: UTF8.self) : nil
    }

    /// The menu at the bottom of a terminal's screen: a block of options, one with ❯,
    /// numbered ("1. Yes") or not ("Yes, I trust this folder"), under a question.
    static func parse(_ screen: String) -> Prompt? {
        var lines = screen.components(separatedBy: "\n")
        while let l = lines.last, l.trimmingCharacters(in: .whitespaces).isEmpty { lines.removeLast() }
        let blank = { (l: String) in l.trimmingCharacters(in: .whitespaces).isEmpty }
        let rule = { (l: String) in
            let t = l.trimmingCharacters(in: .whitespaces)
            return !t.isEmpty && t.allSatisfy { "─━╌┄═-".contains($0) }
        }
        // The last ❯ line with text after it, near the bottom.
        guard let cur = lines.indices.reversed().prefix(14).first(where: { i in
            let l = lines[i]
            guard let r = l.range(of: "❯") else { return false }
            return !l[r.upperBound...].trimmingCharacters(in: .whitespaces).isEmpty
        }) else { return nil }
        let curLine = lines[cur]
        let col = curLine.distance(from: curLine.startIndex, to: curLine.range(of: "❯")!.lowerBound)
        let textCol = col + 2
        func optionText(_ l: String) -> String? {
            let chars = Array(l)
            guard chars.count > textCol else { return nil }
            let lead = String(chars[0..<textCol]).replacingOccurrences(of: "❯", with: " ")
            guard lead.trimmingCharacters(in: .whitespaces).isEmpty, chars[textCol] != " " else { return nil }
            return String(chars[textCol...]).trimmingCharacters(in: .whitespaces)
        }
        func deeper(_ l: String) -> Bool { // a description under an option
            let chars = Array(l)
            return chars.count > textCol && !blank(l) && String(chars[0...textCol]).trimmingCharacters(in: .whitespaces).isEmpty
        }
        var first = cur, last = cur
        var i = cur - 1
        while i >= 0, optionText(lines[i]) != nil || deeper(lines[i]) { if optionText(lines[i]) != nil { first = i }; i -= 1 }
        i = cur + 1
        while i < lines.count, optionText(lines[i]) != nil || deeper(lines[i]) { if optionText(lines[i]) != nil { last = i }; i += 1 }
        var options: [String] = [], cursor = 0
        for j in first...last {
            guard let t = optionText(lines[j]) else { continue }
            if j == cur { cursor = options.count }
            options.append(t.replacingOccurrences(of: #"^\d+\.\s+"#, with: "", options: .regularExpression))
        }
        guard options.count >= 2 else { return nil }
        // The question: the nearest text line above; the context: what's above it, up to a rule.
        var q = first - 1
        while q >= 0, blank(lines[q]) || rule(lines[q]) { q -= 1 }
        let question = q >= 0 ? lines[q].trimmingCharacters(in: .whitespaces) : ""
        var context: [String] = []
        var k = q - 1
        while k >= 0, context.count < 6 {
            let t = lines[k].trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("─") || t.hasPrefix("━") { break }
            if !t.isEmpty, !rule(lines[k]), !t.hasPrefix("Tip:") { context.insert(t, at: 0) }
            k -= 1
        }
        return Prompt(context: Array(context.suffix(3)), question: question, options: options, cursor: cursor)
    }
}

// MARK: - Live statuses straight from herdr-core

/// Follows `hc events`: statuses arrive the moment an agent changes, even while the
/// Herdr window is in the background (it only rewrites state.json when it redraws).
final class LiveFeed: @unchecked Sendable {
    var onStatus: (@Sendable (String, String?) -> Void)?
    private var buffer = Data()

    func start() {
        guard let path = Hc.path else { return }
        let p = Process(), out = Pipe()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = ["events", "--json"]
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let chunk = h.availableData
            guard let self, !chunk.isEmpty else { return }
            self.buffer.append(chunk)
            while let nl = self.buffer.firstIndex(of: 0x0a) {
                let line = self.buffer.subdata(in: self.buffer.startIndex..<nl)
                self.buffer.removeSubrange(self.buffer.startIndex...nl)
                self.handle(line)
            }
        }
        p.terminationHandler = { [weak self] _ in
            out.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { self?.buffer = Data(); self?.start() }
        }
        try? p.run()
    }

    private func handle(_ line: Data) {
        guard let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { return }
        let state = { (status: Any?) in (status as? [String: Any])?["state"] as? String }
        if let terminals = obj["terminals"] as? [[String: Any]] {
            for t in terminals { if let a = t["address"] as? String { onStatus?(a, state(t["status"])) } }
        } else if let params = obj["params"] as? [String: Any], let addr = params["terminal"] as? String,
                  let type = params["type"] as? String {
            let data = params["data"] as? [String: Any]
            if type == "status" { onStatus?(addr, state(data?["status"])) }
            if type == "finished" { onStatus?(addr, nil) }
        }
    }
}

// MARK: - Model

@MainActor
final class Island: ObservableObject {
    @Published var agents: [Agent] = []
    @Published var palette: Palette?
    @Published var closed = true
    @Published var hovering = false
    @Published var alert: Agent?
    @Published var prompts: [String: Prompt] = [:]
    @Published var sending: String?
    private var base: [Agent] = []          // from Herdr: names, icons, finished/idle
    private var live: [String: String?] = [:] // from herdr-core: status right now
    let feed = LiveFeed()
    private var lastFetch: [String: Date] = [:]

    let stateURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".config/herdr-app/island/state.json")
    private var lastModified: Date?
    private var previous: [String: String] = [:]
    private var seeded = false
    private var closedAt: Date?
    private var alertUntil: Date?
    private var icons: [String: NSImage] = [:]

    var working: [Agent] { agents.filter { $0.status == "working" } }
    var needsYou: [Agent] { agents.filter { $0.status == "blocked" } }
    var finished: [Agent] { agents.filter { $0.status == "done" } }
    var busy: Bool { !working.isEmpty || !needsYou.isEmpty || !finished.isEmpty }
    var expanded: Bool { !closed && (hovering || alert != nil) }

    func color(_ status: String) -> Color {
        switch status {
        case "working": return Color(hex: palette?.working, fallback: .yellow)
        case "blocked": return Color(hex: palette?.blocked, fallback: .red)
        case "done": return Color(hex: palette?.done, fallback: .green)
        default: return Color(hex: palette?.idle, fallback: .gray)
        }
    }

    func label(_ status: String) -> String {
        ["working": "Working", "blocked": "Needs you", "done": "Finished"][status] ?? "Idle"
    }

    func image(_ path: String?) -> NSImage? {
        guard let path else { return nil }
        if let cached = icons[path] { return cached }
        // Herdr's SVGs say width="1em": give them a real size or they load ~1px wide.
        var img: NSImage?
        if path.hasSuffix(".svg"), var text = try? String(contentsOfFile: path, encoding: .utf8) {
            text = text.replacingOccurrences(of: "\"1em\"", with: "\"64\"")
            img = NSImage(data: Data(text.utf8))
        } else {
            img = NSImage(contentsOfFile: path)
        }
        img?.size = NSSize(width: 64, height: 64)
        icons[path] = img
        return img
    }

    func tick() {
        let attrs = try? FileManager.default.attributesOfItem(atPath: stateURL.path)
        let modified = attrs?[.modificationDate] as? Date
        if modified != nil && modified != lastModified {
            lastModified = modified
            if let data = try? Data(contentsOf: stateURL), let snap = try? JSONDecoder().decode(Snapshot.self, from: data) {
                apply(snap)
            }
        }
        // Herdr closed (or a layout switch: its mods restart) — hide after a grace period.
        if let closedAt, Date().timeIntervalSince(closedAt) > 2.5, !closed {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { closed = true }
        }
        if let alertUntil, Date() > alertUntil, !hovering {
            self.alertUntil = nil
            withAnimation(.spring(response: 0.4, dampingFraction: 0.85)) { alert = nil }
        }
        // Keep the shown prompts fresh (the agent may have moved on, or the menu changed).
        var shown = Set<String>()
        if let a = alert, a.status == "blocked" { shown.insert(a.address) }
        if hovering { needsYou.forEach { shown.insert($0.address) } }
        for addr in shown where Date().timeIntervalSince(lastFetch[addr] ?? .distantPast) > 1.5 { fetchPrompt(addr) }
    }

    func fetchPrompt(_ address: String) {
        lastFetch[address] = Date()
        DispatchQueue.global(qos: .userInitiated).async {
            let prompt = Hc.run(["read", address]).flatMap(Hc.parse)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    if self.prompts[address] != prompt {
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { self.prompts[address] = prompt }
                    }
                }
            }
        }
    }

    /// Picks option `index` of the agent's menu: moves its ❯ there and presses Enter,
    /// after checking the same menu is still on screen.
    func answer(_ agent: Agent, _ index: Int) {
        guard let shown = prompts[agent.address], sending == nil else { return }
        sending = agent.address
        DispatchQueue.global(qos: .userInitiated).async {
            var ok = false
            if let now = Hc.run(["read", agent.address]).flatMap(Hc.parse), now.options == shown.options, index < now.options.count {
                // Move the ❯ first, check it landed on the choice, and only then press Enter:
                // an Enter that arrives before the moves would accept the default instead.
                let delta = index - now.cursor
                if delta != 0 { _ = Hc.run(["keys", agent.address] + Array(repeating: delta > 0 ? "down" : "up", count: abs(delta))) }
                for _ in 0..<10 {
                    if let check = Hc.run(["read", agent.address]).flatMap(Hc.parse), check.options == shown.options {
                        if check.cursor == index { ok = Hc.run(["keys", agent.address, "enter"]) != nil; break }
                    } else { break }
                    Thread.sleep(forTimeInterval: 0.1)
                }
            }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self.sending = nil
                    if ok { self.settle(agent) } else { self.fetchPrompt(agent.address) }
                }
            }
        }
    }

    func escape(_ agent: Agent) {
        DispatchQueue.global(qos: .userInitiated).async {
            _ = Hc.run(["keys", agent.address, "esc"])
            DispatchQueue.main.async { MainActor.assumeIsolated { self.settle(agent) } }
        }
    }

    private func settle(_ agent: Agent) {
        withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
            prompts[agent.address] = nil
            if alert?.address == agent.address { alert = nil; alertUntil = nil }
        }
    }

    func dismiss() {
        withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { alert = nil; alertUntil = nil }
    }

    /// Opens the answer card for an agent that's waiting.
    func ask(_ agent: Agent) {
        fetchPrompt(agent.address)
        withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { alert = agent; alertUntil = nil }
    }

    // MARK: Sizes (shared by the view and the pointer tracking)

    func promptHeight(_ p: Prompt?) -> CGFloat {
        guard let p else { return Size.row + 40 }
        return 40 + CGFloat(p.context.count) * 17 + (p.question.isEmpty ? 0 : 24) + CGFloat(min(p.options.count, 6)) * 32 + 44
    }

    func size(_ notch: Notch) -> CGSize {
        if closed { return CGSize(width: notch.width, height: notch.height) }
        if let a = alert {
            let body = a.status == "blocked" ? promptHeight(prompts[a.address]) : Size.row + 14
            return CGSize(width: Size.expandedWidth, height: notch.height + body)
        }
        if hovering {
            let rows = min(max(agents.count, 1), Size.maxRows)
            return CGSize(width: Size.expandedWidth, height: notch.height + 34 + CGFloat(rows) * Size.row + 12)
        }
        if busy { return CGSize(width: notch.width + 2 * Size.wing, height: notch.height) }
        return CGSize(width: notch.width, height: notch.height)
    }

    func startLive() {
        feed.onStatus = { addr, state in
            DispatchQueue.main.async { MainActor.assumeIsolated { self.setLive(addr, state) } }
        }
        feed.start()
    }

    private func setLive(_ addr: String, _ state: String?) {
        if let known = live[addr], known == state { return }
        live[addr] = state
        if base.contains(where: { $0.address == addr }) { recompute() }
    }

    private func apply(_ snap: Snapshot) {
        if snap.closed { if closedAt == nil { closedAt = Date() }; return }
        closedAt = nil
        base = snap.agents
        palette = snap.colors ?? palette
        recompute()
    }

    /// Herdr's agents with herdr-core's live status on top. "done" is Herdr's word for
    /// finished-while-you-weren't-looking: once Herdr says idle (seen), it stays idle.
    private func recompute() {
        let fresh: [Agent] = base.map { a in
            var a = a
            if let entry = live[a.address], let s = entry {
                switch s {
                case "working", "blocked": a.status = s
                case "done": a.status = a.status == "idle" ? "idle" : "done"
                case "idle": a.status = "idle"
                default: break
                }
            }
            return a
        }
        // Pop open on an agent that just finished or needs you.
        var popped: Agent?
        if seeded {
            for a in fresh where a.status == "blocked" || a.status == "done" {
                if previous[a.address] != a.status { popped = popped ?? a }
            }
        }
        previous = Dictionary(uniqueKeysWithValues: fresh.map { ($0.address, $0.status) })
        seeded = true
        withAnimation(.spring(response: 0.4, dampingFraction: 0.82)) {
            closed = false
            agents = fresh
            if let popped, !popped.focused || !NSWorkspace.shared.isHerdrFrontmost {
                alert = popped
                // A finished agent shows for a moment; one waiting on you stays until answered.
                alertUntil = popped.status == "blocked" ? nil : Date().addingTimeInterval(6)
                if popped.status == "blocked" { fetchPrompt(popped.address) }
            } else if let current = alert {
                let updated = fresh.first(where: { $0.address == current.address })
                if updated == nil || (current.status == "blocked" && updated?.status != "blocked") { alert = nil; alertUntil = nil }
                else { alert = updated }
            }
            for addr in prompts.keys where !fresh.contains(where: { $0.address == addr && $0.status == "blocked" }) { prompts[addr] = nil }
        }
    }

    func focus(_ agent: Agent) {
        let candidates = ["\(NSHomeDirectory())/.local/bin/herdr-app", "/opt/homebrew/bin/herdr-app", "/usr/local/bin/herdr-app"]
        if let tool = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: tool)
            p.arguments = ["do", "agent.focus", "--terminal", agent.address]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try? p.run()
        }
        openHerdr()
        withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { alert = nil; alertUntil = nil }
    }

    func openHerdr() {
        // `open -b` sends a reopen: it also brings back a minimized window (activate alone doesn't).
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = ["-b", "dev.herdr.app"]
        try? p.run()
    }
}

extension NSWorkspace {
    var isHerdrFrontmost: Bool { frontmostApplication?.bundleIdentifier == "dev.herdr.app" }
}

// MARK: - Geometry

struct Notch {
    var width: CGFloat
    var height: CGFloat
    var hasNotch: Bool

    static func of(_ screen: NSScreen) -> Notch {
        if let l = screen.auxiliaryTopLeftArea, let r = screen.auxiliaryTopRightArea, screen.safeAreaInsets.top > 0 {
            return Notch(width: screen.frame.width - l.width - r.width, height: screen.safeAreaInsets.top, hasNotch: true)
        }
        return Notch(width: 190, height: NSStatusBar.system.thickness, hasNotch: false)
    }
}

enum Size {
    static let wing: CGFloat = 64
    // Stops short of the first menu-bar icon right of the notch (~205pt from the
    // screen's centre here): macOS draws some of those (the ▶ indicator) above every window.
    static let expandedWidth: CGFloat = 384
    static let row: CGFloat = 50
    static let maxRows = 7
    static let canvas = CGSize(width: 520, height: 470)
}

// MARK: - Views

struct Spinner: View {
    var color: Color
    var size: CGFloat = 12
    @State private var spin = false
    var body: some View {
        Circle().trim(from: 0.15, to: 0.85)
            .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
            .frame(width: size, height: size)
            .rotationEffect(.degrees(spin ? 360 : 0))
            .onAppear { withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { spin = true } }
    }
}

struct IslandShape: Shape {
    var radius: CGFloat
    /// The band beside the notch (menu bar height) is never wider than this, so the
    /// open island doesn't cover menu-bar icons: it widens only below the menu bar.
    var topWidth: CGFloat
    var topHeight: CGFloat
    var animatableData: CGFloat { get { radius } set { radius = newValue } }

    func path(in r: CGRect) -> Path {
        var p = Path()
        let f: CGFloat = 6 // outward flares where it meets the screen edge, like the hardware notch
        let tw = min(r.width, topWidth), x0 = r.midX - tw / 2, x1 = r.midX + tw / 2
        let shoulder = min(10, (r.width - tw) / 2), th = min(topHeight, r.height - radius)
        p.move(to: CGPoint(x: x0 - f, y: r.minY))
        p.addQuadCurve(to: CGPoint(x: x0, y: r.minY + f), control: CGPoint(x: x0, y: r.minY))
        if shoulder >= 1 {
            // Down beside the notch, then out to the full width below the menu bar.
            p.addLine(to: CGPoint(x: x0, y: th - shoulder))
            p.addQuadCurve(to: CGPoint(x: x0 - shoulder, y: th), control: CGPoint(x: x0, y: th))
            p.addLine(to: CGPoint(x: r.minX + shoulder, y: th))
            p.addQuadCurve(to: CGPoint(x: r.minX, y: th + shoulder), control: CGPoint(x: r.minX, y: th))
        }
        p.addLine(to: CGPoint(x: r.minX, y: r.maxY - radius))
        p.addQuadCurve(to: CGPoint(x: r.minX + radius, y: r.maxY), control: CGPoint(x: r.minX, y: r.maxY))
        p.addLine(to: CGPoint(x: r.maxX - radius, y: r.maxY))
        p.addQuadCurve(to: CGPoint(x: r.maxX, y: r.maxY - radius), control: CGPoint(x: r.maxX, y: r.maxY))
        if shoulder >= 1 {
            p.addLine(to: CGPoint(x: r.maxX, y: th + shoulder))
            p.addQuadCurve(to: CGPoint(x: r.maxX - shoulder, y: th), control: CGPoint(x: r.maxX, y: th))
            p.addLine(to: CGPoint(x: x1 + shoulder, y: th))
            p.addQuadCurve(to: CGPoint(x: x1, y: th - shoulder), control: CGPoint(x: x1, y: th))
        }
        p.addLine(to: CGPoint(x: x1, y: r.minY + f))
        p.addQuadCurve(to: CGPoint(x: x1 + f, y: r.minY), control: CGPoint(x: x1, y: r.minY))
        p.closeSubpath()
        return p
    }
}

struct AgentIcon: View {
    @ObservedObject var island: Island
    var agent: Agent
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6).fill(Color(hex: agent.tile, fallback: Color.white.opacity(0.12)))
            if let img = island.image(agent.icon) {
                if agent.tint {
                    Image(nsImage: img).renderingMode(.template).resizable().scaledToFit()
                        .foregroundStyle(.white).padding(4)
                } else {
                    Image(nsImage: img).resizable().scaledToFit().padding(agent.tile == nil ? 0 : 4)
                }
            } else {
                Text(String(agent.name.prefix(1))).font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
            }
        }
        .frame(width: 26, height: 26)
    }
}

struct StatusBadge: View {
    @ObservedObject var island: Island
    var status: String
    var body: some View {
        HStack(spacing: 5) {
            if status == "working" { Spinner(color: island.color(status), size: 10) }
            else { Circle().fill(island.color(status)).frame(width: 7, height: 7) }
            Text(island.label(status)).font(.system(size: 11, weight: .medium))
                .foregroundStyle(status == "idle" ? Color.white.opacity(0.45) : island.color(status))
        }
    }
}

struct AgentRow: View {
    @ObservedObject var island: Island
    var agent: Agent
    var answerable = true
    @State private var hover = false
    var body: some View {
        HStack(spacing: 10) {
            AgentIcon(island: island, agent: agent)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(agent.name).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(.white)
                    Text("\(agent.spaceName) · \(agent.tabName ?? "")").font(.system(size: 11.5))
                        .foregroundStyle(.white.opacity(0.5)).lineLimit(1)
                }
                if let title = agent.title, !title.isEmpty, title != agent.name {
                    Text(title).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.65)).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            if answerable && agent.status == "blocked" {
                Button { island.ask(agent) } label: {
                    Text("Answer").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.white)
                        .padding(.horizontal, 10).frame(height: 24)
                        .background(Capsule().fill(island.color("blocked")))
                }.buttonStyle(.plain)
            } else {
                StatusBadge(island: island, status: agent.status)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: Size.row - 4)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(hover ? 0.10 : 0)))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture { island.focus(agent) }
    }
}

/// An agent waiting on a menu: what it's about, the question, one button per choice.
struct PromptCard: View {
    @ObservedObject var island: Island
    var agent: Agent
    var body: some View {
        let prompt = island.prompts[agent.address]
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                AgentIcon(island: island, agent: agent).scaleEffect(0.85)
                Text(agent.name).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(.white)
                Text("\(agent.spaceName) · \(agent.tabName ?? "")").font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.5)).lineLimit(1)
                Spacer(minLength: 4)
                Button { island.dismiss() } label: {
                    Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.white.opacity(0.5))
                        .frame(width: 22, height: 22).contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
            .frame(height: 30)
            if let prompt {
                ForEach(Array(prompt.context.enumerated()), id: \.offset) { _, line in
                    Text(line).font(.system(size: 11, design: .monospaced)).foregroundStyle(.white.opacity(0.6))
                        .lineLimit(1).truncationMode(.middle).frame(height: 15)
                }
                if !prompt.question.isEmpty {
                    Text(prompt.question).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(.white)
                        .lineLimit(1).frame(height: 20)
                }
                VStack(spacing: 4) {
                    ForEach(Array(prompt.options.prefix(6).enumerated()), id: \.offset) { i, option in
                        OptionButton(island: island, agent: agent, index: i, text: option, current: i == prompt.cursor)
                    }
                }
                HStack {
                    Button("Esc · cancel") { island.escape(agent) }
                        .buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(.white.opacity(0.5))
                    Spacer()
                    Button("Open in Herdr") { island.focus(agent) }
                        .buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(.white.opacity(0.6))
                }
                .frame(height: 22)
            } else {
                HStack {
                    Text("Needs you in its terminal").font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
                    Spacer()
                    Button("Open in Herdr") { island.focus(agent) }
                        .buttonStyle(.plain).font(.system(size: 11.5)).foregroundStyle(island.color("blocked"))
                }
                .frame(height: 30)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
    }
}

struct OptionButton: View {
    @ObservedObject var island: Island
    var agent: Agent
    var index: Int
    var text: String
    var current: Bool
    @State private var hover = false
    var body: some View {
        Button { island.answer(agent, index) } label: {
            HStack(spacing: 8) {
                Text("\(index + 1)").font(.system(size: 10.5, weight: .bold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.7)).frame(width: 18, height: 18)
                    .background(RoundedRectangle(cornerRadius: 5).fill(Color.white.opacity(0.12)))
                Text(text).font(.system(size: 12)).foregroundStyle(.white).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
                if island.sending == agent.address { ProgressView().controlSize(.mini) }
            }
            .padding(.horizontal, 8).frame(height: 28)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(hover ? 0.18 : current ? 0.11 : 0.06)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .disabled(island.sending != nil)
    }
}

struct IslandView: View {
    @ObservedObject var island: Island
    var notch: Notch

    var size: CGSize { island.size(notch) }

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                IslandShape(radius: island.expanded ? 22 : 10, topWidth: .infinity, topHeight: notch.height).fill(Color.black)
                content
            }
            .frame(width: size.width, height: size.height)
            .clipShape(IslandShape(radius: island.expanded ? 22 : 10, topWidth: .infinity, topHeight: notch.height))
            .shadow(color: .black.opacity(island.expanded ? 0.45 : 0), radius: 16, y: 6)
            .opacity(island.closed && notch.hasNotch == false ? 0 : 1)
            Spacer(minLength: 0)
        }
        .frame(width: Size.canvas.width, height: Size.canvas.height, alignment: .top)
        .animation(.spring(response: 0.38, dampingFraction: 0.82), value: size)
    }

    @ViewBuilder var content: some View {
        if island.closed {
            EmptyView()
        } else if let alert = island.alert {
            VStack(spacing: 0) {
                wings.frame(width: notch.width + 2 * Size.wing, height: notch.height)
                if alert.status == "blocked" {
                    PromptCard(island: island, agent: alert)
                } else {
                    AgentRow(island: island, agent: alert).padding(.horizontal, 8).padding(.top, 4)
                }
            }
            .transition(.opacity)
        } else if island.hovering {
            VStack(spacing: 0) {
                wings.frame(width: notch.width + 2 * Size.wing, height: notch.height)
                HStack {
                    Text("Herdr").font(.system(size: 12, weight: .semibold)).foregroundStyle(.white.opacity(0.9))
                    Text(summary).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5))
                    Spacer()
                    Button("Open Herdr") { island.openHerdr() }
                        .buttonStyle(.plain).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.6))
                }
                .padding(.horizontal, 18).frame(height: 30)
                if island.agents.isEmpty {
                    Text("No agents running").font(.system(size: 12)).foregroundStyle(.white.opacity(0.45))
                        .frame(height: Size.row)
                } else {
                    VStack(spacing: 4) {
                        ForEach(Array(island.agents.prefix(island.agents.count > Size.maxRows ? Size.maxRows - 1 : Size.maxRows))) {
                            AgentRow(island: island, agent: $0)
                        }
                        if island.agents.count > Size.maxRows {
                            Button("+\(island.agents.count - Size.maxRows + 1) more in Herdr") { island.openHerdr() }
                                .buttonStyle(.plain).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5))
                                .frame(height: Size.row - 4)
                        }
                    }
                    .padding(.horizontal, 8)
                }
            }
            .transition(.opacity)
        } else {
            wings.frame(width: notch.width + 2 * Size.wing, height: notch.height)
        }
    }

    var summary: String {
        var parts: [String] = []
        if !island.needsYou.isEmpty { parts.append("\(island.needsYou.count) need you") }
        if !island.finished.isEmpty { parts.append("\(island.finished.count) finished") }
        if !island.working.isEmpty { parts.append("\(island.working.count) working") }
        return parts.isEmpty ? "All quiet" : parts.joined(separator: " · ")
    }

    // Beside the notch: working on the left, needs-you / finished on the right.
    var wings: some View {
        HStack(spacing: 0) {
            HStack(spacing: 6) {
                if !island.working.isEmpty {
                    Spinner(color: island.color("working"), size: 12)
                    Text("\(island.working.count)").font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundStyle(island.color("working"))
                }
            }
            .frame(width: Size.wing, alignment: .center)
            Spacer(minLength: notch.width)
            HStack(spacing: 5) {
                if !island.needsYou.isEmpty {
                    Circle().fill(island.color("blocked")).frame(width: 8, height: 8)
                    Text("\(island.needsYou.count)").font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundStyle(island.color("blocked"))
                } else if !island.finished.isEmpty {
                    Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(island.color("done"))
                    Text("\(island.finished.count)").font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundStyle(island.color("done"))
                }
            }
            .frame(width: Size.wing, alignment: .center)
        }
    }
}

// MARK: - Window

final class ClickThroughHost<V: View>: NSHostingView<V> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class IslandPanel: NSPanel {
    // Windows are normally kept below the menu bar; the island belongs over it, on the notch.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let island = Island()
    var panel: IslandPanel!
    var notch = Notch(width: 190, height: 32, hasNotch: false)
    var screen: NSScreen?

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.accessory)
        panel = IslandPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        // The highest level apps can use: the open island covers the menu bar and its icons.
        panel.level = NSWindow.Level(rawValue: Int(CGShieldingWindowLevel()))
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = true
        place()
        panel.orderFrontRegardless()
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.place() }
        }
        island.startLive()
        Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.island.tick() }
        }
        Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.trackMouse() }
        }
    }

    func place() {
        let s = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) ?? NSScreen.main ?? NSScreen.screens[0]
        screen = s
        notch = Notch.of(s)
        let f = s.frame
        panel.setFrame(NSRect(x: f.midX - Size.canvas.width / 2, y: f.maxY - Size.canvas.height,
                              width: Size.canvas.width, height: Size.canvas.height), display: true)
        panel.contentView = ClickThroughHost(rootView: IslandView(island: island, notch: notch))
    }

    // The panel is mostly empty: only the island itself takes the pointer.
    func trackMouse() {
        guard let s = screen else { return }
        let m = NSEvent.mouseLocation, f = s.frame
        let sz = island.size(notch)
        let w = island.closed ? 0 : sz.width, h = sz.height + (island.expanded ? 12 : 2)
        // The band beside the notch stays narrow (menu-bar icons stay clickable);
        // only the part below the menu bar is wide.
        let tw = w, th = min(notch.height, h)
        let band = NSRect(x: f.midX - tw / 2, y: f.maxY - th, width: tw, height: th)
        let body = NSRect(x: f.midX - w / 2, y: f.maxY - h, width: w, height: h - th)
        let inside = w > 0 && (band.contains(m) || body.contains(m))
        panel.ignoresMouseEvents = !inside
        if inside != island.hovering {
            withAnimation(.spring(response: 0.38, dampingFraction: 0.82)) { island.hovering = inside }
        }
    }
}

@main
struct HerdrIslandMain {
    @MainActor static func main() {
        // Debug: `HerdrIsland --snapshot out.png rest|hover|alert` renders the island
        // from the current state.json to a PNG (no screen-recording permission needed).
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--prompt"), args.count > i + 1 {
            let p = Hc.run(["read", args[i + 1]]).flatMap(Hc.parse)
            print(p.map { "context: \($0.context)\nquestion: \($0.question)\noptions: \($0.options)\ncursor: \($0.cursor)" } ?? "no prompt")
            exit(0)
        }
        if let i = args.firstIndex(of: "--snapshot"), args.count > i + 2 {
            let island = Island()
            island.tick()
            let mode = args[i + 2]
            island.hovering = mode == "hover"
            if mode == "alert" { island.alert = island.agents.first }
            let notch = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }).map(Notch.of) ?? Notch(width: 190, height: 37, hasNotch: true)
            let view = IslandView(island: island, notch: notch)
                .background(Color(white: 0.85))
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            if let img = renderer.nsImage, let tiff = img.tiffRepresentation,
               let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: args[i + 1]))
            }
            exit(0)
        }
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
