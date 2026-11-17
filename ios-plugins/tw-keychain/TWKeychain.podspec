require 'json'

Pod::Spec.new do |s|
  s.name             = 'TWKeychain'
  s.version          = '1.0.0'
  s.summary          = 'Territory Walk の匿名ID・チームを iOS Keychain に保存する最小プラグイン'
  s.description      = <<-DESC
    App を削除して再インストールしても同じ匿名ユーザーIDで再開できるよう、
    匿名ID・所属チーム・引き継ぎコードを Keychain（kSecClassGenericPassword）へ
    読み書きする Capacitor 6 用のブリッジ。外部の Keychain ライブラリには依存しない
    （Security.framework を直接使う）ので、CocoaPods の解決で追加の Pod は入らない。
  DESC
  s.homepage         = 'https://shodai4.com/territory-walk/'
  s.license          = { :type => 'MIT' }
  s.author           = { 'Shodai' => 'shodai121ueda@gmail.com' }
  s.source           = { :path => '.' }

  s.source_files     = 'Plugin/**/*.swift'
  s.ios.deployment_target = '15.0'
  s.swift_version    = '5.0'

  s.dependency 'Capacitor'
end
