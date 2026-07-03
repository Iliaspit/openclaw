import SwiftUI

@MainActor
struct ChatDesktopSidebar: View {
    @Bindable var viewModel: OpenClawChatViewModel
    @Binding var showSessions: Bool
    let showsSessionSwitcher: Bool

    @State private var showsSettings = true

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Button {
                self.viewModel.newChat()
            } label: {
                Label("New chat", systemImage: "square.and.pencil")
                    .font(.system(size: 14, weight: .semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.white.opacity(0.06))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)))

            VStack(alignment: .leading, spacing: 10) {
                Text("Agents")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)

                if self.viewModel.activeSubagents.isEmpty {
                    Text("Subagents will appear here while they are running.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(self.viewModel.activeSubagents) { agent in
                        Button {
                            self.viewModel.switchSession(to: agent.sessionKey)
                        } label: {
                            ChatDesktopSidebarAgentRow(agent: agent)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if self.showsSessionSwitcher {
                Button {
                    self.showSessions = true
                } label: {
                    HStack(spacing: 8) {
                        Label("OpenClaw sessions", systemImage: "clock.arrow.circlepath")
                            .font(.system(size: 13, weight: .medium))
                        Spacer(minLength: 0)
                        Text("\(self.viewModel.sessionChoices.count)")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(Color.white.opacity(0.04))
                            .overlay(
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)))
                }
                .buttonStyle(.plain)
            }

            Spacer(minLength: 0)

            DisclosureGroup(isExpanded: self.$showsSettings) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(self.viewModel.healthOK ? Color.green : Color.orange)
                            .frame(width: 8, height: 8)
                        Text(self.viewModel.healthOK ? "Connected" : "Connecting")
                            .font(.caption.weight(.semibold))
                        Spacer(minLength: 0)
                    }

                    Text(self.currentSessionTitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)

                    Button {
                        self.viewModel.refresh()
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                            .font(.caption.weight(.medium))
                    }
                    .buttonStyle(.plain)
                }
                .padding(.top, 10)
            } label: {
                Label("OpenClaw settings", systemImage: "slider.horizontal.3")
                    .font(.system(size: 13, weight: .semibold))
            }
            .tint(.primary)
        }
        .padding(18)
        .frame(width: 260)
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .background(
            LinearGradient(
                colors: [
                    Color.accentColor.opacity(0.10),
                    OpenClawChatTheme.surface.opacity(0.96),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing,
            )
        )
        .overlay(alignment: .trailing) {
            Rectangle()
                .fill(OpenClawChatTheme.divider)
                .frame(width: 1)
        }
    }

    private var currentSessionTitle: String {
        let current = self.viewModel.sessions.first { $0.key == self.viewModel.sessionKey }
        let displayName = current?.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return displayName.isEmpty ? self.viewModel.sessionKey : displayName
    }
}

@MainActor
private struct ChatDesktopSidebarAgentRow: View {
    let agent: OpenClawChatSidebarAgent

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(self.agent.isRunning ? Color.accentColor : Color.secondary.opacity(0.5))
                .frame(width: 8, height: 8)
                .padding(.top, 5)

            VStack(alignment: .leading, spacing: 4) {
                Text(self.agent.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                if let subtitle = self.agent.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }

            Spacer(minLength: 0)

            Text(self.agent.status)
                .font(.caption2.weight(.medium))
                .foregroundStyle(self.agent.isRunning ? Color.accentColor : .secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.white.opacity(0.04))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)))
    }
}

@MainActor
struct ChatRunActivityPanel: View {
    let viewModel: OpenClawChatViewModel

    @State private var showsThinking = true
    @State private var showsChecklist = true

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if self.showsThinkingSection {
                DisclosureGroup(isExpanded: self.$showsThinking) {
                    VStack(alignment: .leading, spacing: 8) {
                        if self.viewModel.thinkingBlocks.isEmpty {
                            HStack(spacing: 8) {
                                DesktopActivityDots()
                                Text("Thinking…")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        } else {
                            ForEach(self.viewModel.thinkingBlocks.prefix(6)) { block in
                                ChatThinkingBlockCard(block: block)
                            }
                        }
                    }
                    .padding(.top, 8)
                } label: {
                    HStack(spacing: 8) {
                        Text("Thinking")
                            .font(.system(size: 13, weight: .semibold))
                        if self.viewModel.isThinkingActive || self.viewModel.pendingRunCount > 0 {
                            DesktopActivityDots()
                        }
                    }
                }
                .tint(.primary)
            }

            if !self.viewModel.checklistEntries.isEmpty {
                DisclosureGroup(isExpanded: self.$showsChecklist) {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(self.viewModel.checklistEntries.prefix(10)) { entry in
                            ChatChecklistEntryRow(entry: entry)
                        }
                    }
                    .padding(.top, 8)
                } label: {
                    HStack(spacing: 8) {
                        Text("Checklist")
                            .font(.system(size: 13, weight: .semibold))
                        Text("\(self.viewModel.checklistEntries.count)")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
                .tint(.primary)
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(OpenClawChatTheme.subtleCard)
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)))
    }

    private var showsThinkingSection: Bool {
        self.viewModel.pendingRunCount > 0 ||
            self.viewModel.isThinkingActive ||
            !self.viewModel.thinkingBlocks.isEmpty
    }
}

@MainActor
private struct ChatThinkingBlockCard: View {
    let block: OpenClawChatThinkingBlock

    @State private var showsFullText = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(self.block.title)
                    .font(.caption.weight(.semibold))
                if self.block.isStreaming {
                    DesktopActivityDots()
                }
                Spacer(minLength: 0)
                if self.canExpand {
                    Button(self.showsFullText ? "Less" : "More") {
                        self.showsFullText.toggle()
                    }
                    .buttonStyle(.plain)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
            }

            Text(self.showsFullText ? self.block.text : self.block.summary)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(self.showsFullText ? nil : 4)
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.white.opacity(0.04))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)))
    }

    private var canExpand: Bool {
        self.block.text != self.block.summary
    }
}

@MainActor
private struct ChatChecklistEntryRow: View {
    let entry: OpenClawChatChecklistEntry

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: self.symbolName)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(self.symbolColor)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(self.entry.title)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    if let sessionTitle = self.entry.sessionTitle, !sessionTitle.isEmpty {
                        Text(sessionTitle)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                if let detail = self.entry.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.white.opacity(0.04))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)))
    }

    private var symbolName: String {
        switch self.entry.state {
        case .pending:
            return "circle"
        case .running:
            return "circle.dotted"
        case .completed:
            return "checkmark.circle.fill"
        case .blocked:
            return "pause.circle.fill"
        case .failed:
            return "xmark.circle.fill"
        }
    }

    private var symbolColor: Color {
        switch self.entry.state {
        case .pending:
            return .secondary
        case .running:
            return .accentColor
        case .completed:
            return .green
        case .blocked:
            return .orange
        case .failed:
            return .red
        }
    }
}

@MainActor
private struct DesktopActivityDots: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var animate = false

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Color.secondary.opacity(0.55))
                    .frame(width: 5, height: 5)
                    .scaleEffect(self.reduceMotion ? 0.9 : (self.animate ? 1.05 : 0.72))
                    .opacity(self.reduceMotion ? 0.55 : (self.animate ? 0.95 : 0.32))
                    .animation(
                        self.reduceMotion ? nil : .easeInOut(duration: 0.55)
                            .repeatForever(autoreverses: true)
                            .delay(Double(index) * 0.16),
                        value: self.animate)
            }
        }
        .onAppear { self.updateAnimationState() }
        .onDisappear { self.animate = false }
        .onChange(of: self.scenePhase) { _, _ in
            self.updateAnimationState()
        }
        .onChange(of: self.reduceMotion) { _, _ in
            self.updateAnimationState()
        }
    }

    private func updateAnimationState() {
        guard !self.reduceMotion, self.scenePhase == .active else {
            self.animate = false
            return
        }
        self.animate = true
    }
}
