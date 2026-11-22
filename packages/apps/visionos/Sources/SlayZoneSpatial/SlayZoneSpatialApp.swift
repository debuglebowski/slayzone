import SwiftUI

@main
struct SlayZoneSpatialApp: App {
    var body: some Scene {
        // The launcher: hub address + the project list.
        WindowGroup(id: "launcher") {
            LauncherView()
        }
        .defaultSize(width: 700, height: 800)

        WindowGroup("SlayZone workspace", id: PanelSpec.Scene.workspace.rawValue, for: PanelSpec.self) { $spec in
            if let spec { PanelWindow(spec: spec, minWidth: 520, minHeight: 420) }
        }
        .defaultSize(width: 1150, height: 780)
        .windowResizability(.contentMinSize)

        WindowGroup("Terminal", id: PanelSpec.Scene.terminal.rawValue, for: PanelSpec.self) { $spec in
            if let spec { PanelWindow(spec: spec, minWidth: 420, minHeight: 300) }
        }
        .defaultSize(width: 820, height: 530)
        .windowResizability(.contentMinSize)

        WindowGroup("Task details", id: PanelSpec.Scene.details.rawValue, for: PanelSpec.self) { $spec in
            if let spec { PanelWindow(spec: spec, minWidth: 360, minHeight: 400) }
        }
        .defaultSize(width: 530, height: 720)
        .windowResizability(.contentMinSize)
    }
}

/// Routes a page's messages to window actions.
private struct SpatialMessageRouter {
    let openWindow: OpenWindowAction
    let dismiss: () -> Void

    func handle(_ message: SpatialMessage) {
        switch message {
        case .open(let spec): openWindow(id: spec.scene.rawValue, value: spec)
        case .close: dismiss()
        }
    }
}

struct PanelWindow: View {
    let spec: PanelSpec
    let minWidth: CGFloat
    let minHeight: CGFloat
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow

    var body: some View {
        let router = SpatialMessageRouter(openWindow: openWindow) {
            dismissWindow(id: spec.scene.rawValue, value: spec)
        }
        PanelWebView(url: spec.url, onMessage: router.handle)
            .frame(minWidth: minWidth, minHeight: minHeight)
            .navigationTitle(spec.title)
    }
}

struct LauncherView: View {
    @AppStorage(HubAddress.storageKey) private var hubText = HubAddress.defaultURL
    @State private var draft = ""
    @State private var editing = false
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let hub = HubAddress.normalized(hubText)
        NavigationStack {
            Group {
                if let hub, !editing {
                    let router = SpatialMessageRouter(openWindow: openWindow) {}
                    PanelWebView(url: HubAddress.launcherURL(hub: hub), onMessage: router.handle)
                } else {
                    hubForm
                }
            }
            .navigationTitle("SlayZone")
            .toolbar {
                if hub != nil, !editing {
                    Button("Hub", systemImage: "server.rack") {
                        draft = hubText
                        editing = true
                    }
                }
            }
        }
    }

    private var hubForm: some View {
        Form {
            Section("SlayZone hub") {
                TextField("http://your-mac.local:3000", text: $draft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                if !draft.isEmpty && HubAddress.normalized(draft) == nil {
                    Text("Enter an http(s) address.").foregroundStyle(.secondary)
                }
            }
            Button("Connect") {
                if let url = HubAddress.normalized(draft) {
                    hubText = url.absoluteString
                    editing = false
                }
            }
            .disabled(HubAddress.normalized(draft) == nil)
        }
        .onAppear { if draft.isEmpty { draft = hubText } }
    }
}
