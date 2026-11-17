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
//  同期の方針（2026-11-17 修正）
//    ・送った状態は必ず端末に残す（UserDefaults）。Watch が後から起動しても
//      activationDidComplete のタイミングで送り直せる。
//    ・updateApplicationContext（最新値勝ち）に加えて、届く相手がいれば sendMessage で即送る。
//    ・Watch からの {"cmd":"sync"} には、JS を経由せず **ネイティブが保存済みの状態をそのまま返事**する。
//      これで「JS の準備前に Watch が起動して、何も返らないまま固まる」ことが無くなる。
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

    /// 最後に Watch へ渡した状態（Watch が後から起動しても即描画できるように残す）
    private let contextKey = "tw.watch.lastContext"
    private let stateLock = NSLock()
    private var lastContext: [String: Any]?
    private var pendingContext: [String: Any]?

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
        cacheContext(payload)
        let session = WCSession.default
        guard session.activationState == .activated else {
            // 起動直後などでまだ activated でない: 完了時にまとめて送る（捨てない）
            stateLock.lock()
            pendingContext = payload
            stateLock.unlock()
            activate()
            return
        }
        transmit(payload, session: session)
    }

    /// WatchへACK（キューから消してよいseq）
    func ackToWatch(seq: Int) {
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else { return }
        session.sendMessage(["cmd": "ack", "seq": seq], replyHandler: nil, errorHandler: nil)
    }

    // MARK: 送信の中身
    /// 保存済み（または今の）状態。Watch からの sync に即答するために使う
    private var currentContext: [String: Any]? {
        stateLock.lock()
        let value = lastContext
        stateLock.unlock()
        return value ?? loadCachedContext()
    }

    private func cacheContext(_ payload: [String: Any]) {
        // JSON を通すと plist に載る型（NSNumber/NSString/NSArray/NSDictionary）に揃う
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        stateLock.lock()
        lastContext = payload
        stateLock.unlock()
        UserDefaults.standard.set(data, forKey: contextKey)
    }

    private func loadCachedContext() -> [String: Any]? {
        guard let data = UserDefaults.standard.data(forKey: contextKey),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dict = object as? [String: Any] else { return nil }
        return dict
    }

    /// 診断用: すでに Watch へ渡せる状態を持っているか
    var hasContext: Bool { currentContext != nil }

    /// updateApplicationContext（最新値勝ち・Watchが起動していなくても残る）＋
    /// 届く相手がいれば sendMessage（今すぐ描画）
    private func transmit(_ payload: [String: Any], session: WCSession) {
        guard JSONSerialization.isValidJSONObject(payload) else {
            CAPLog.print("[Watch] payload is not JSON-serializable; skipped")
            return
        }
        do {
            try session.updateApplicationContext(payload)
        } catch {
            CAPLog.print("[Watch] updateApplicationContext failed: \(error.localizedDescription)")
        }
        if session.isReachable {
            session.sendMessage(payload, replyHandler: nil, errorHandler: { error in
                CAPLog.print("[Watch] sendMessage failed: \(error.localizedDescription)")
            })
        }
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
                 error: Error?) {
        guard activationState == .activated else {
            CAPLog.print("[Watch] activation did not complete: \(error?.localizedDescription ?? "unknown")")
            return
        }
        // 起動直後に送り損ねた状態 → 最後に送った状態 の順で送り直す
        stateLock.lock()
        let pending = pendingContext
        pendingContext = nil
        stateLock.unlock()

        if let payload = pending ?? currentContext {
            transmit(payload, session: session)
        }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    /// Watch のアプリが入った・ペアリングが変わった
    func sessionWatchStateDidChange(_ session: WCSession) {
        guard session.isWatchAppInstalled, let payload = currentContext else { return }
        transmit(payload, session: session)
    }

    /// Watch が起きて届くようになったら、最新の状態をすぐ渡す
    func sessionReachabilityDidChange(_ session: WCSession) {
        guard session.isReachable, let payload = currentContext else { return }
        transmit(payload, session: session)
    }

    /// Watchのボタン操作・ズーム要求・再同期要求
    func session(_ session: WCSession, didReceiveMessage message: [String: Any],
                 replyHandler: @escaping ([String: Any]) -> Void) {
        onCommand?(message)
        if (message["cmd"] as? String) == "sync" {
            if let payload = currentContext {
                // 返事にそのまま状態を載せる（Watch はこれを描く）
                replyHandler(payload)
                // 念のため applicationContext も更新しておく
                transmit(payload, session: session)
                return
            }
            replyHandler(["cmd": "waiting"])
            return
        }
        replyHandler(["ok": true])
    }

    /// Watchの記録バッチ（遅延同期）。ここではSupabaseに書かず、inboxへ積んでJSに渡す
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        // 「今すぐ同期して」の予約（iPhone のアプリが閉じていた間に届く）
        if (userInfo["cmd"] as? String) == "sync" {
            if let payload = currentContext {
                transmit(payload, session: session)
            }
            return
        }
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
            "reachable": reachable,
            "hasContext": WatchSessionManager.shared.hasContext
        ])
    }
}
