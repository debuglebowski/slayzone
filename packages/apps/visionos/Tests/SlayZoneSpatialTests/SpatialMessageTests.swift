import XCTest
@testable import SlayZoneSpatial

final class SpatialMessageTests: XCTestCase {
    func testParsesOpen() {
        let message = SpatialMessage(body: [
            "type": "open",
            "url": "http://localhost:3000/?spatial=task&task=t1",
            "title": "Fix login",
        ])
        XCTAssertEqual(
            message,
            .open(PanelSpec(url: URL(string: "http://localhost:3000/?spatial=task&task=t1")!,
                            title: "Fix login")))
    }

    func testOpenDefaultsAnEmptyTitle() {
        let message = SpatialMessage(body: ["type": "open", "url": "http://h/?spatial=launcher", "title": ""])
        guard case .open(let spec) = message else { return XCTFail("expected open") }
        XCTAssertEqual(spec.title, "SlayZone")
    }

    func testWindowIdentityUsesTaskPanelAndGroup() {
        func panel(_ group: String, name: String, title: String, view: String = "terminal") -> PanelSpec {
            let url = URL(string: "http://h/?spatial=panel&task=t1&view=\(view)&group=\(group)&groupName=\(name)")!
            return PanelSpec(url: url, title: title)
        }

        let terminal = panel("g1", name: "Review", title: "Terminal")
        XCTAssertEqual(terminal.scene, .terminal)
        XCTAssertEqual(terminal, panel("g1", name: "Updated", title: "Renamed"))
        XCTAssertNotEqual(terminal, panel("g2", name: "Review", title: "Terminal"))
        XCTAssertEqual(panel("g1", name: "Review", title: "Details", view: "settings").scene, .details)
    }

    func testHubOriginIncludesSchemeHostAndEffectivePort() {
        let hub = URL(string: "https://hub.example.com/path")!
        XCTAssertTrue(HubAddress.sameOrigin(hub, URL(string: "https://hub.example.com:443/")!))
        XCTAssertFalse(HubAddress.sameOrigin(hub, URL(string: "https://hub.example.com:4000/")!))
        XCTAssertFalse(HubAddress.sameOrigin(hub, URL(string: "http://hub.example.com/")!))
    }

    func testParsesClose() {
        XCTAssertEqual(SpatialMessage(body: ["type": "close"]), .close)
    }

    func testRejectsMalformedMessages() {
        XCTAssertNil(SpatialMessage(body: "open"))
        XCTAssertNil(SpatialMessage(body: ["type": "teleport"]))
        XCTAssertNil(SpatialMessage(body: ["type": "open"]))
        XCTAssertNil(SpatialMessage(body: ["type": "open", "url": "javascript:alert(1)"]))
        XCTAssertNil(SpatialMessage(body: ["type": "open", "url": "file:///etc/passwd"]))
    }

    func testNormalizesHubAddress() {
        XCTAssertEqual(HubAddress.normalized(" my-mac.local:3000 ")?.absoluteString,
                       "http://my-mac.local:3000")
        XCTAssertEqual(HubAddress.normalized("https://hub.example.com")?.absoluteString,
                       "https://hub.example.com")
        XCTAssertNil(HubAddress.normalized(""))
        XCTAssertNil(HubAddress.normalized("ftp://x"))
    }

    func testLauncherURL() {
        let hub = URL(string: "http://localhost:3000")!
        XCTAssertEqual(HubAddress.launcherURL(hub: hub).absoluteString,
                       "http://localhost:3000/?spatial=launcher")
    }
}
