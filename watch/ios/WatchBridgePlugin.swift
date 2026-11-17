//
//  WatchBridgePlugin.swift
//  iPhone側のWatch連携（WatchConnectivity＋状態送出＋Watch操作の受信＋無音通知）
//
//  置き場所: ios/App/App/WatchBridgePlugin.swift（Appターゲット）
//  登録: scripts/configure-watch.js が ios/App/App/capacitor.config.json の
//        packageClassList に "WatchBridgePlugin" を足す（Capacitor 6 の自動登録）
//  起動: AppDelegate.swift に WatchSessionManager.shared.activate() を1行足す（best-effort）
//
//  JS側の窓口: watch-bridge.js（window.Capacitor.Plugins.WatchBridge）
//

import Foundation
import Capacitor
import WatchConnectivity
import UserNotifications

// MARK: - セッション管理（iOS側の中心）
final class WatchSessionManager: NSObject, WCSessionDelegate {
    static let shared = WatchSessionManager()

    /// Watch → iPhone の操作（toggle / window / sync）をJSへ渡すコールバック
    var onCommand: (([String: Any]) -> Void)?

    /// Watch が貯めた記録（Phase 2 の単独記録）を JS が拾えるようにファイルへ退避する
    private let inboxURL: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("watch-inbox.json")
    }()

    func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        if session.activationState == .notActivated {
            session.activate()
        }
    }

    /// JS → Watch の状態送出（最新値勝ち）
    func pushContext(_ payload: [String: Any]) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated else { return }
        do {
            try session.updateApplicationContext(payload)
        } catch {
            // Watchが未ペアリング・未インストールのときは普通に失敗する。次回の送信で追いつく
        }
    }

    /// WatchへACK（キューから消してよいseq）
    func ackToWatch(seq: Int) {
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else { return }
        session.sendMessage(["cmd": "ack", "seq": seq], replyHandler: nil, errorHandler: nil)
    }

    // MARK: Watch → iPhone の記録（inbox）
    // inbox は「バッチの配列」＝ [[[String: Any]]]（1バッチ＝Watchがまとめたタイル配列）。
    // JS側（watch-bridge.js）は result.items を配列として受け取り、各要素をタイル配列として読む。
    private func readInbox() -> [[[String: Any]]] {
        guard let data = try? Data(contentsOf: inboxURL),
              let object = try? JSONSerialization.jsonObject(with: data),
              let batches = object as? [[[String: Any]]] else { return [] }
        return batches
    }

    private func writeInbox(_ batches: [[[String: Any]]]) {
        guard let data = try? JSONSerialization.data(withJSONObject: batches, options: []) else { return }
        try? data.write(to: inboxURL, options: .atomic)
    }

    /// JSから呼ぶ: 溜まったWatch記録を取り出して空にする
    func drainInbox() -> [[[String: Any]]] {
        let batches = readInbox()
        try? FileManager.default.removeItem(at: inboxURL)
        return batches
    }

    // MARK: WCSessionDelegate
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {}

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    /// Watchのボタン操作・ズーム要求
    func session(_ session: WCSession, didReceiveMessage message: [String: Any],
                 replyHandler: @escaping ([String: Any]) -> Void) {
        onCommand?(message)
        replyHandler(["ok": true])
    }

    /// Watchの記録バッチ（遅延同期）。ここではSupabaseに書かず、inboxへ積んでJSに渡す
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        guard (userInfo["kind"] as? String) == "tiles" else { return }
        guard let tiles = userInfo["tiles"] as? [[String: Any]] else { return }
        var batches = readInbox()
        batches.append(tiles)
        writeInbox(batches)
    }
}

// MARK: - 無音通知（陣地取得・奪還）
// sound に「無音の短いwav」を指定するのが要点。
// sound=nil にすると Watch も振動しない（Appleの挙動）ため、無音の音源を鳴らす扱いにする。
enum SilentNotifier {
    static let soundFileName = "silent.wav"

    /// 権限要求。ユーザーが通知をONにした時だけ呼ぶ（起動時には呼ばない）
    static func requestAuthorization(completion: @escaping (Bool) -> Void) {
        UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
                completion(granted)
            }
    }

    /// kind: "claim" | "steal"
    static func notify(kind: String, body: String) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized
                || settings.authorizationStatus == .provisional else { return }

            let content = UNMutableNotificationContent()
            content.title = kind == "steal" ? "陣地を奪われました" : "陣地を獲得しました"
            content.body = body
            content.sound = UNNotificationSound(named: UNNotificationSoundName(soundFileName))
            content.threadIdentifier = "territory"
            if #available(iOS 15.0, *) {
                // .passive は振動しない方向なので使わない
                content.interruptionLevel = .active
            }
            let request = UNNotificationRequest(identifier: "territory-\(kind)",
                                                content: content,
                                                trigger: nil)   // 即時
            center.add(request, withCompletionHandler: nil)
        }
    }
}

// MARK: - Capacitor プラグイン
@objc(WatchBridgePlugin)
public class WatchBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WatchBridgePlugin"
    public let jsName = "WatchBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "updateState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drainInbox", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ackInbox", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "notifyCapture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestNotificationPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise)
    ]

    public override func load() {
        WatchSessionManager.shared.activate()
        WatchSessionManager.shared.onCommand = { [weak self] message in
            self?.notifyListeners("command", data: message)
        }
    }

    @objc func updateState(_ call: CAPPluginCall) {
        // CAPPluginCall.options は Capacitor のバージョンでキー型が変わるため、
        // String キーだけを拾って [String: Any] に詰め替える。
        var payload: [String: Any] = [:]
        for (key, value) in call.options {
            if let key = key as? String {
                payload[key] = value
            }
        }
        WatchSessionManager.shared.pushContext(payload)
        call.resolve()
    }

    @objc func drainInbox(_ call: CAPPluginCall) {
        call.resolve(["items": WatchSessionManager.shared.drainInbox()])
    }

    @objc func ackInbox(_ call: CAPPluginCall) {
        WatchSessionManager.shared.ackToWatch(seq: call.getInt("upToSeq") ?? 0)
        call.resolve()
    }

    @objc func notifyCapture(_ call: CAPPluginCall) {
        SilentNotifier.notify(kind: call.getString("kind") ?? "claim",
                              body: call.getString("body") ?? "")
        call.resolve()
    }

    @objc func requestNotificationPermission(_ call: CAPPluginCall) {
        SilentNotifier.requestAuthorization { granted in
            call.resolve(["granted": granted])
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        let supported = WCSession.isSupported()
        var paired = false
        var installed = false
        var reachable = false
        if supported {
            let session = WCSession.default
            paired = session.isPaired
            installed = session.isWatchAppInstalled
            reachable = session.isReachable
        }
        call.resolve([
            "supported": supported,
            "paired": paired,
            "installed": installed,
            "reachable": reachable
        ])
    }
}
