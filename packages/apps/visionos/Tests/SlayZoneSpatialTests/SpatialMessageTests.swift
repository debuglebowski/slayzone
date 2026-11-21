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
