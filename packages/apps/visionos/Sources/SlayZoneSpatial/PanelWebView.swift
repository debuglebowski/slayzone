import SwiftUI
import WebKit

/// A WKWebView showing one SlayZone panel. Every panel shares the default
/// website data store, so a hub sign-in (an HttpOnly cookie) covers them all,
/// while each keeps its own sessionStorage (= its own server-side windowId).
struct PanelWebView: UIViewRepresentable {
    let url: URL
    /// Called with every valid message the page posts.
    let onMessage: (SpatialMessage) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onMessage: onMessage) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        // A weak proxy: WKUserContentController retains its handlers strongly.
        config.userContentController.add(
            WeakMessageHandler(context.coordinator), name: SpatialMessage.handlerName)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isInspectable = true  // Debug from Safari > Develop on the Mac.
        webView.isOpaque = false
        webView.load(URLRequest(url: url))
        context.coordinator.loadedURL = url
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.onMessage = onMessage
        if context.coordinator.loadedURL != url {
            context.coordinator.loadedURL = url
            webView.load(URLRequest(url: url))
        }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController
            .removeScriptMessageHandler(forName: SpatialMessage.handlerName)
    }

    final class Coordinator: NSObject, WKScriptMessageHandler {
        var onMessage: (SpatialMessage) -> Void
        var loadedURL: URL?

        init(onMessage: @escaping (SpatialMessage) -> Void) { self.onMessage = onMessage }

        func userContentController(
            _ controller: WKUserContentController, didReceive message: WKScriptMessage
        ) {
            guard let parsed = SpatialMessage(body: message.body) else { return }
            onMessage(parsed)
        }
    }
}

private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }

    func userContentController(
        _ controller: WKUserContentController, didReceive message: WKScriptMessage
    ) {
        target?.userContentController(controller, didReceive: message)
    }
}
