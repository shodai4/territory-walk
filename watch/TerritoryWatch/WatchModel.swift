//
//  WatchModel.swift
//  TERRITORY WALK Watch App（コンパニオン版 Phase 1）
//
//  iPhone（watch-bridge.js → WatchBridgePlugin）から updateApplicationContext で
//  「今いる周りのマス」を受け取り、地図に重ねるだけのモデル。
//  Watch単独の測位は Phase 2。ここでは位置情報の許可ダイアログを出さない。
//

import Foundation
import MapKit
import SwiftUI        // withAnimation / ObservableObject（Combine）
import WatchConnectivity
import WatchKit

// MARK: - iPhone側 grid.js と同じ定数（ここがズレるとマスがズレる）
enum Grid {
    static let latStep = 0.0009
    static let lngStep = latStep / cos(35.0 * Double.pi / 180.0)   // 経度は緯度35度で補正

    static func corners(latIdx: Int, lngIdx: Int) -> [CLLocationCoordinate2D] {
        let south = Double(latIdx) * latStep
        let north = south + latStep
        let west = Double(lngIdx) * lngStep
        let east = west + lngStep
        return [
            .init(latitude: south, longitude: west),
            .init(latitude: south, longitude: east),
            .init(latitude: north, longitude: east),
            .init(latitude: north, longitude: west)
        ]
    }

    static func center(latIdx: Int, lngIdx: Int) -> CLLocationCoordinate2D {
        .init(latitude: (Double(latIdx) + 0.5) * latStep,
              longitude: (Double(lngIdx) + 0.5) * lngStep)
    }
}

// MARK: - 窓データ（iPhoneと共有するJSON）
struct TileWindow: Equatable {
    var la: Int          // 窓左上の latIdx
    var lo: Int          // 窓左上の lngIdx
    var n: Int           // 一辺
    var youRow: Int      // 現在地の窓内位置
    var youCol: Int
    var marking: Bool
    var g: [Character]   // n*n: "0"=不明 "1"=白 "2"=黒

    init?(dict: [String: Any]) {
        guard let la = dict["la"] as? Int, let lo = dict["lo"] as? Int,
              let n = dict["n"] as? Int, let g = dict["g"] as? String,
              g.count == n * n, n >= 2, n <= 31 else { return nil }
        let you = (dict["you"] as? [NSNumber])?.map { $0.intValue } ?? [n / 2, n / 2]
        self.la = la
        self.lo = lo
        self.n = n
        self.youRow = you.first ?? (n / 2)
        self.youCol = you.count > 1 ? you[1] : (n / 2)
        self.marking = (dict["marking"] as? Bool) ?? true
        self.g = Array(g)
    }

    var meCoordinate: CLLocationCoordinate2D {
        Grid.center(latIdx: la + youRow, lngIdx: lo + youCol)
    }

    /// 画面に描くマスだけを返す（不明のマスは描かない＝白と誤表示しない）
    struct Cell: Identifiable {
        let latIdx: Int
        let lngIdx: Int
        let team: Int            // 1=白 2=黒
        var id: String { "\(latIdx)_\(lngIdx)" }
    }

    func cells(radius: Int) -> [Cell] {
        let r = max(1, min(radius, n / 2))
        var out: [Cell] = []
        let rowRange = (youRow - r)...(youRow + r)
        let colRange = (youCol - r)...(youCol + r)
        for row in rowRange where row >= 0 && row < n {
            for col in colRange where col >= 0 && col < n {
                let ch = g[row * n + col]
                guard let team = ch.wholeNumberValue, team == 1 || team == 2 else { continue }
                out.append(Cell(latIdx: la + row, lngIdx: lo + col, team: team))
            }
        }
        return out
    }
}

// MARK: - モデル（WCSession 受信＋状態）
final class WatchModel: NSObject, ObservableObject, WCSessionDelegate {
    @Published var camera: MapCameraPosition = .automatic
    @Published private(set) var window: TileWindow?
    @Published private(set) var reachable = false
    @Published private(set) var lastUpdate: Date?

    /// ズーム段（度）。小さいほど拡大。250m/500m/1km/2km四方の目安。
    private let spans: [Double] = [0.00225, 0.0045, 0.009, 0.018]
    private let radii: [Int] = [2, 4, 7, 7]
    private var zoomIndex = 1
    private var lastCenterLatIdx: Int?
    private var lastCenterLngIdx: Int?

    override init() {
        super.init()
        activate()
    }

    var span: Double { spans[min(zoomIndex, spans.count - 1)] }
    var visibleCells: [TileWindow.Cell] { window?.cells(radius: cellsRadius) ?? [] }
    private var cellsRadius: Int { radii[min(zoomIndex, radii.count - 1)] }
    var marking: Bool { window?.marking ?? true }
    var meCoordinate: CLLocationCoordinate2D? { window?.meCoordinate }
    var hasWindow: Bool { window != nil }

    func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        if session.activationState == .notActivated {
            session.activate()
        }
    }

    // ---- 状態更新 -------------------------------------------------
    private func apply(_ dict: [String: Any]) {
        guard let next = TileWindow(dict: dict) else { return }
        let centerChanged = lastCenterLatIdx != next.la + next.youRow || lastCenterLngIdx != next.lo + next.youCol
        window = next
        lastUpdate = Date()
        lastCenterLatIdx = next.la + next.youRow
        lastCenterLngIdx = next.lo + next.youCol

        // 中心がマス単位で変わった時だけカメラを動かす（毎秒動かすと目が疲れる）
        if centerChanged {
            withAnimation(.easeInOut(duration: 0.35)) {
                camera = .region(MKCoordinateRegion(center: next.meCoordinate,
                                                    span: MKCoordinateSpan(latitudeDelta: span,
                                                                           longitudeDelta: span)))
            }
        }
    }

    // ---- ズーム ---------------------------------------------------
    func zoomIn() {
        guard zoomIndex > 0 else { return }
        zoomIndex -= 1
        recenterAnimated()
        requestWindow()
    }

    func zoomOut() {
        guard zoomIndex < spans.count - 1 else { return }
        zoomIndex += 1
        recenterAnimated()
        requestWindow()
    }

    var canZoomIn: Bool { zoomIndex > 0 }
    var canZoomOut: Bool { zoomIndex < spans.count - 1 }

    private func recenterAnimated() {
        guard let center = window?.meCoordinate else { return }
        withAnimation(.easeInOut(duration: 0.25)) {
            camera = .region(MKCoordinateRegion(center: center,
                                                span: MKCoordinateSpan(latitudeDelta: span, longitudeDelta: span)))
        }
    }

    /// ズーム段が変わると必要なマス範囲が変わるので、iPhoneに窓サイズを要求する
    private func requestWindow() {
        let session = WCSession.default
        guard session.activationState == .activated else { return }
        session.sendMessage(["cmd": "window", "r": cellsRadius], replyHandler: nil, errorHandler: nil)
    }

    // ---- マーキングON/OFF -----------------------------------------
    func toggleMarking() {
        let next = !marking
        WKInterfaceDevice.current().play(.click)
        // 楽観更新（失敗したら戻す）
        if var updated = window {
            updated.marking = next
            window = updated
        }

        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else {
            if var updated = window {
                updated.marking = !next
                window = updated
            }
            return
        }
        session.sendMessage(["cmd": "toggle", "to": next], replyHandler: { reply in
            let applied = (reply["marking"] as? Bool) ?? next
            DispatchQueue.main.async {
                if var updated = self.window {
                    updated.marking = applied
                    self.window = updated
                }
            }
        }, errorHandler: { _ in
            DispatchQueue.main.async {
                if var updated = self.window {
                    updated.marking = !next
                    self.window = updated
                }
            }
        })
    }

    // ---- WCSessionDelegate ---------------------------------------
    func session(_ session: WCSession,
                 activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {
        DispatchQueue.main.async {
            self.reachable = session.isReachable
            if let context = session.receivedApplicationContext as [String: Any]?, !context.isEmpty {
                self.apply(context)
            }
        }
        if activationState == .activated {
            requestWindow()
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async { self.reachable = session.isReachable }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        DispatchQueue.main.async { self.apply(applicationContext) }
    }
}
