import Foundation

/// One window's content: which SlayZone web panel it shows.
/// Codable + Hashable so SwiftUI can open (and restore) a window per panel.
struct PanelSpec: Codable, Hashable {
    var url: URL
    var title: String
}

/// A message posted by the web renderer through
/// `window.webkit.messageHandlers.slayzoneSpatial.postMessage(...)`.
/// Mirrors `SpatialHostMessage` in renderer-app/src/spatial/spatial-bridge.ts.
enum SpatialMessage: Equatable {
    case open(PanelSpec)
    case close

    static let handlerName = "slayzoneSpatial"

    /// Parses the body WKScriptMessage delivers (a JS object arrives as a dictionary).
    /// Returns nil for anything malformed.
    init?(body: Any) {
        guard let dict = body as? [String: Any], let type = dict["type"] as? String else { return nil }
        switch type {
        case "open":
            guard let urlString = dict["url"] as? String,
                  let url = URL(string: urlString),
                  url.scheme == "http" || url.scheme == "https"
            else { return nil }
            let title = (dict["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "SlayZone"
            self = .open(PanelSpec(url: url, title: title))
        case "close":
            self = .close
        default:
            return nil
        }
    }
}

/// Where the hub lives and the URL of each entry panel.
enum HubAddress {
    static let storageKey = "hubURL"
    static let defaultURL = "http://localhost:3000"

    /// The hub's base URL from user input, or nil if it isn't a usable http(s) URL.
    static func normalized(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return nil }
        if !text.contains("://") { text = "http://" + text }
        guard let url = URL(string: text),
              let scheme = url.scheme, scheme == "http" || scheme == "https",
              url.host != nil
        else { return nil }
        return url
    }

    /// The launcher panel (the project list) on that hub.
    static func launcherURL(hub: URL) -> URL {
        var components = URLComponents(url: hub, resolvingAgainstBaseURL: false)!
        if components.path.isEmpty { components.path = "/" }
        components.queryItems = [URLQueryItem(name: "spatial", value: "launcher")]
        return components.url!
    }
}
