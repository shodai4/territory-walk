//
//  WatchModel.swift
//  TERRITORY WALK Watch App（コンパニオン版 Phase 1）
//
//  iPhone（watch-bridge.js → WatchBridgePlugin）から
//  「今いる周りのマス」を受け取り、地図に重ねるだけのモデル。
//  Watch単独の測位は Phase 2。ここでは位置情報の許可ダイアログを出さない。
//
//  同期は「3本の道」で取りに行く（1本が塞がっても地図が出るように）。
//    1. receivedApplicationContext（iPhone が最後に送った状態。再起動後も残る）
//    2. 起動・フォアグラウンド復帰・到達可能になった時に {"cmd":"sync"} を送り、
//       返事(reply)のなかに窓データが入っていればそのまま描く
//    3. 届かないときは 3秒→15秒 で自動リトライ（iPhone のアプリが起きていなくても、
//       次に起きるまで transferUserInfo で要求をためておく）
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

    /// WCSession で渡ってくる数値は NSNumber（しかも中身は Double のことがある）。
    /// `as? Int` だけで受けると **全部 nil になって窓が捨てられる**（＝「iPhoneと接続中」のまま止まる）。
    /// ここで型を吸収しておく。
    static func intValue(_ any: Any?) -> Int? {
        if let number = any as? NSNumber { return number.intValue }
        if let value = any as? Int { return value }
        if let value = any as? Double, value.isFinite { return Int(value) }
        if let value = any as? String {
            if let parsed = Int(value) { return parsed }
            if let parsed = Double(value), parsed.isFinite { return Int(parsed) }
        }
        return nil
    }

    static func boolValue(_ any: Any?) -> Bool? {
        if let number = any as? NSNumber { return number.boolValue }
        if let value = any as? Bool { return value }
        if let value = any as? String { return value == "1" || value.lowercased() == "true" }
        return nil
    }

    init?(dict: [String: Any]) {
        guard let la = TileWindow.intValue(dict["la"]),
              let lo = TileWindow.intValue(dict["lo"]),
              let n = TileWindow.intValue(dict["n"]),
              let g = dict["g"] as? String,
              g.count == n * n, n >= 2, n <= 31 else { return nil }

        let you = (dict["you"] as? [Any])?.compactMap { TileWindow.intValue($0) } ?? []
        self.la = la
        self.lo = lo
        self.n = n
        self.youRow = you.first ?? (n / 2)
        self.youCol = you.count > 1 ? you[1] : (n / 2)
        self.marking = TileWindow.boolValue(dict["marking"]) ?? true
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

// MARK: - 前回の窓を端末に残す（Watch だけで開いても地図が出る）
enum WatchWindowCache {
    static let key = "tw.watch.window"

    static func load() -> [String: Any]? {
        guard let data = UserDefaults.standard.data(forKey: key),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dict = object as? [String: Any] else { return nil }
        return dict
    }

    static func save(_ dict: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(dict),
              let data = try? JSONSerialization.data(withJSONObject: dict) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }
}

// MARK: - モデル（WCSession 受信＋状態）
final class WatchModel: NSObject, ObservableObject, WCSessionDelegate {
    @Published var camera: MapCameraPosition = .automatic
    @Published private(set) var window: TileWindow?
    @Published private(set) var reachable = false
    @Published private(set) var lastUpdate: Date?
    /// 10秒たっても一度も届かないときに「iPhoneのアプリを開いてね」を出す
    @Published private(set) var showHint = false

    /// ズーム段（度）。小さいほど拡大。250m/500m/1km/2km四方の目安。
    private let spans: [Double] = [0.00225, 0.0045, 0.009, 0.018]
    private let radii: [Int] = [2, 4, 7, 7]
    private var zoomIndex = 1
    private var lastCenterLatIdx: Int?
    private var lastCenterLngIdx: Int?

    /// 一度でも今回の起動で iPhone から受け取ったか（キャッシュ表示と区別する）
    private var hasLiveUpdate = false
    private var syncTimer: Timer?
    private var syncAttempts = 0
    private var hintTimer: Timer?
    private var supported = false

    /// 窓がまだ無いときの地図の初期位置（渋谷）。`.automatic` のままだと
    /// 中身が無いあいだ地図が読み込み中のままになるため、必ず具体的な範囲を入れる。
    private let fallbackCenter = CLLocationCoordinate2D(latitude: 35.658034, longitude: 139.701636)

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
        // 前回の表示をまず出す（真っ暗・ぐるぐるを避ける）。中身は次の受信で上書きする。
        if let cached = WatchWindowCache.load(), let restored = TileWindow(dict: cached) {
            window = restored
            lastCenterLatIdx = restored.la + restored.youRow
            lastCenterLngIdx = restored.lo + restored.youCol
            camera = .region(region(for: restored.meCoordinate))
        } else {
            camera = .region(region(for: fallbackCenter))
        }

        guard WCSession.isSupported() else { return }
        supported = true
        let session = WCSession.default
        session.delegate = self
        if session.activationState == .notActivated {
            session.activate()
        }
        // 起動直後に1回たたく（iPhone 側が起きていればこの返事で即描画）
        requestSync()
    }

    /// 画面がアクティブに戻ったとき（Watch を下ろして再度開いた等）
    func onForeground() {
        if WCSession.isSupported() {
            let context = WCSession.default.receivedApplicationContext
            if !context.isEmpty {
                _ = apply(context)
            }
        }
        requestSync()
    }

    /// タイマーはメインスレッドでしか動かないので、WCSession のデリゲート
    /// （バックグラウンドのキュー）から呼ばれても必ずメインへ移してから処理する。
    private func runOnMain(_ block: @escaping () -> Void) {
        if Thread.isMainThread {
            block()
        } else {
            DispatchQueue.main.async(execute: block)
        }
    }

    private func region(for center: CLLocationCoordinate2D) -> MKCoordinateRegion {
        MKCoordinateRegion(center: center,
                           span: MKCoordinateSpan(latitudeDelta: span, longitudeDelta: span))
    }

    // ---- 状態更新 -------------------------------------------------
    @discardableResult
    private func apply(_ dict: [String: Any]) -> Bool {
        guard let next = TileWindow(dict: dict) else { return false }
        let centerChanged = lastCenterLatIdx != next.la + next.youRow || lastCenterLngIdx != next.lo + next.youCol
        window = next
        lastUpdate = Date()
        hasLiveUpdate = true
        lastCenterLatIdx = next.la + next.youRow
        lastCenterLngIdx = next.lo + next.youCol
        WatchWindowCache.save(dict)
        stopSyncRetry()

        // 中心がマス単位で変わった時だけカメラを動かす（毎秒動かすと目が疲れる）
        if centerChanged {
            withAnimation(.easeInOut(duration: 0.35)) {
                camera = .region(region(for: next.meCoordinate))
            }
        }
        return true
    }

    // ---- iPhone への再同期要求 --------------------------------------
    /// 起動時・復帰時・到達可能になったときに呼ぶ。届かなければ自動でリトライする。
    func requestSync() {
        runOnMain { [weak self] in self?.requestSyncOnMain() }
    }

    private func requestSyncOnMain() {
        guard supported else { return }
        let session = WCSession.default
        guard session.activationState == .activated else {
            scheduleSyncRetry()
            return
        }
        startHintTimer()

        if session.isReachable {
            session.sendMessage(["cmd": "sync"], replyHandler: { [weak self] reply in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    // 返事に窓データが入っていればそのまま描く（applicationContext を待たない）
                    if !self.apply(reply) {
                        self.scheduleSyncRetry()
                    }
                }
            }, errorHandler: { [weak self] _ in
                DispatchQueue.main.async { self?.scheduleSyncRetry() }
            })
        } else {
            // iPhone のアプリが起きていない: 次に起きるまでためておく（取りこぼし防止）
            if syncAttempts % 3 == 0 {
                session.transferUserInfo(["cmd": "sync"])
            }
            scheduleSyncRetry()
        }
    }

    private func scheduleSyncRetry() {
        runOnMain { [weak self] in self?.scheduleSyncRetryOnMain() }
    }

    private func scheduleSyncRetryOnMain() {
        guard supported, !hasLiveUpdate, syncTimer == nil else { return }
        syncAttempts += 1
        let interval: TimeInterval = syncAttempts <= 6 ? 3 : 15
        syncTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.syncTimer = nil
            if !self.hasLiveUpdate { self.requestSync() }
        }
    }

    private func stopSyncRetry() {
        runOnMain { [weak self] in
            guard let self = self else { return }
            self.syncTimer?.invalidate()
            self.syncTimer = nil
            self.hintTimer?.invalidate()
            self.hintTimer = nil
            if self.showHint { self.showHint = false }
        }
    }

    /// 10秒たっても届かないときだけ、控えめな案内に切り替える（ずっと「接続中」で止めない）
    private func startHintTimer() {
        runOnMain { [weak self] in self?.startHintTimerOnMain() }
    }

    private func startHintTimerOnMain() {
        guard !hasLiveUpdate, hintTimer == nil, !showHint else { return }
        hintTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.hintTimer = nil
            if !self.hasLiveUpdate {
                DispatchQueue.main.async { self.showHint = true }
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
            camera = .region(region(for: center))
        }
    }

    /// ズーム段が変わると必要なマス範囲が変わるので、iPhoneに窓サイズを要求する
    private func requestWindow() {
        let session = WCSession.default
        guard session.activationState == .activated else { return }
        guard session.isReachable else {
            // 届かないときは次の同期でまとめて取り直す（マスは今の範囲のまま）
            requestSync()
            return
        }
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
            requestSync()
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
                _ = self.apply(context)
            }
        }
        if activationState == .activated {
            requestSync()
        } else {
            DispatchQueue.main.async { self.scheduleSyncRetry() }
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async {
            self.reachable = session.isReachable
            if session.isReachable && !self.hasLiveUpdate {
                self.requestSync()
            }
        }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        DispatchQueue.main.async {
            self.reachable = session.isReachable
            _ = self.apply(applicationContext)
        }
    }

    /// iPhone からの即時送信（sendMessage: 返事なし）
    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        DispatchQueue.main.async { _ = self.apply(message) }
    }

    /// iPhone からの即時送信（返事あり）
    func session(_ session: WCSession, didReceiveMessage message: [String: Any],
                 replyHandler: @escaping ([String: Any]) -> Void) {
        DispatchQueue.main.async { _ = self.apply(message) }
        replyHandler(["ok": true])
    }
}
