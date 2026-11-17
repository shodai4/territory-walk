//
//  TWKeychainPlugin.swift
//  Territory Walk — iOS Keychain bridge
//
//  匿名ユーザーID・所属チーム・引き継ぎコードを Keychain に保存する。
//  iOS ではアプリを削除しても Keychain の項目は残るため、再インストール後に
//  同じ匿名IDで再開でき、チームの選び直し（セマラ）や戦績の消失を防げる。
//
//  ・Security.framework を直接使い、外部の Keychain ライブラリに依存しない
//  ・kSecAttrAccessibleAfterFirstUnlock（端末の初回ロック解除後は、画面ロック中でも読める）
//      → バックグラウンド測位中にアプリが起動しても読める
//  ・kSecAttrSynchronizable は付けない（iCloud キーチェーン同期はしない／端末内のみ）
//
//  JS 側からは window.Capacitor.Plugins.TWKeychain（または registerPlugin('TWKeychain')）で
//    get({ key })    -> { value: string | null }
//    set({ key, value }) -> { saved: true }
//    remove({ key }) -> { removed: true }
//  として呼ぶ。プラグイン名の登録は ios/App/App/capacitor.config.json の
//  packageClassList（scripts/configure-ios.js が追記）で行う。
//

import Foundation
import Capacitor
import Security

@objc(TWKeychainPlugin)
public class TWKeychainPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TWKeychainPlugin"
    public let jsName = "TWKeychain"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ping", returnType: CAPPluginReturnPromise)
    ]

    /// Keychain のサービス名（アプリ固有）。Bundle ID とは独立に固定し、
    /// 将来 Bundle ID を変えても保存済みの匿名IDを失わないようにする。
    private let defaultService = "com.shodai.territorywalk.identity"

    private func resolvedService(_ call: CAPPluginCall) -> String {
        let value = call.getString("service") ?? ""
        return value.isEmpty ? defaultService : value
    }

    private func baseQuery(key: String, service: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
    }

    /// ネイティブ側の準備確認用（JS からプラグインの有無を確かめる）
    @objc public func ping(_ call: CAPPluginCall) {
        call.resolve(["available": true, "platform": "ios"])
    }

    @objc public func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("key is required")
            return
        }

        var query = baseQuery(key: key, service: resolvedService(call))
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)

        if status == errSecSuccess {
            if let data = item as? Data, let value = String(data: data, encoding: .utf8) {
                call.resolve(["value": value])
            } else {
                call.resolve(["value": NSNull()])
            }
            return
        }

        // 未登録はエラーではなく「値なし」として返す（起動時の初回扱い）
        if status == errSecItemNotFound {
            call.resolve(["value": NSNull()])
            return
        }

        call.reject("keychain read failed (status \(status))")
    }

    @objc public func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty,
              let value = call.getString("value") else {
            call.reject("key and value are required")
            return
        }

        let service = resolvedService(call)
        let data = Data(value.utf8)
        let query = baseQuery(key: key, service: service)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]

        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess {
            call.resolve(["saved": true])
            return
        }
        if updateStatus != errSecItemNotFound {
            call.reject("keychain update failed (status \(updateStatus))")
            return
        }

        var addQuery = query
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        if addStatus == errSecSuccess {
            call.resolve(["saved": true])
        } else {
            call.reject("keychain write failed (status \(addStatus))")
        }
    }

    @objc public func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("key is required")
            return
        }

        let status = SecItemDelete(baseQuery(key: key, service: resolvedService(call)) as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve(["removed": true])
        } else {
            call.reject("keychain delete failed (status \(status))")
        }
    }
}
