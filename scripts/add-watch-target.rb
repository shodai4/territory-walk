#!/usr/bin/env ruby
# frozen_string_literal: true
#
# TERRITORY WALK - add-watch-target.rb
#
# `npx cap add ios` が生成した ios/App/App.xcodeproj に、Apple Watch（コンパニオン）の
# 単一ターゲット Watch アプリを追加する。CIで毎回作り直す前提（生成物はコミットしない）。
#
# 前提:
#   - node scripts/configure-watch.js 済み（Swift/Assets のコピーと packageClassList の更新）
#   - ruby の xcodeproj gem（CocoaPods が依存しているので macOS ランナーには入っている）
#   - `pod install` の後ろで実行する（pod install は App ターゲットの build phase を触るため）
#
# 使い方:
#   ruby scripts/add-watch-target.rb
#   WATCH_EMBED=plugins ruby scripts/add-watch-target.rb   # Xcodeが PlugIns/ 埋め込みを要求した場合
#
# 検証（実機/CIで一度は必ず確認する）:
#   xcodebuild -list -project ios/App/App.xcodeproj          # ターゲットが2つ見える
#   unzip -l <ipa> | grep -i watch                            # Watchアプリが入っている
#

require 'xcodeproj'

ROOT = File.expand_path('..', __dir__)
PROJECT_PATH = File.join(ROOT, 'ios', 'App', 'App.xcodeproj')
APP_TARGET_NAME = 'App'
WATCH_TARGET_NAME = 'TerritoryWatch Watch App'
WATCH_SOURCE_DIR = 'TerritoryWatch'                       # ios/App/TerritoryWatch/
APP_SOURCE_DIR = 'App'                                    # ios/App/App/
WATCH_BUNDLE_ID = 'com.oekaki.territorywalk.watchkitapp'
COMPANION_BUNDLE_ID = 'com.oekaki.territorywalk'
WATCHOS_DEPLOYMENT_TARGET = ENV.fetch('WATCHOS_DEPLOYMENT_TARGET', '10.0')
WATCH_DISPLAY_NAME = 'テリウォーク'
EMBED_MODE = ENV.fetch('WATCH_EMBED', 'watch')            # 'watch' => $(CONTENTS_FOLDER_PATH)/Watch, 'plugins' => PlugIns/
BRIDGE_SWIFT = 'WatchBridgePlugin.swift'
SILENT_SOUND = 'silent.wav'

abort("[watch] project not found: #{PROJECT_PATH}") unless File.exist?(PROJECT_PATH)

project = Xcodeproj::Project.open(PROJECT_PATH)
app = project.targets.find { |t| t.name == APP_TARGET_NAME }
abort('[watch] App target not found') unless app

# バージョンは必ず iPhone アプリと揃える（ずれるとアップロード検証で落ちる）
APP_CONFIG = app.build_configurations.first
APP_MARKETING_VERSION = ENV.fetch('MARKETING_VERSION',
  (APP_CONFIG && APP_CONFIG.build_settings['MARKETING_VERSION']) || '1.0')
APP_BUILD_NUMBER = ENV.fetch('CURRENT_PROJECT_VERSION',
  (APP_CONFIG && APP_CONFIG.build_settings['CURRENT_PROJECT_VERSION']) || '1')

# ---------------------------------------------------------------- App ターゲット側
# WatchBridgePlugin.swift（ソース）と silent.wav（リソース）を App ターゲットに追加する
app_group = project.main_group.find_subpath(APP_SOURCE_DIR, false)
abort('[watch] App group not found') unless app_group

def add_file_once(group, target, name, phase)
  existing = group.children.find { |child| child.path == name }
  ref = existing || group.new_file(name)
  files = phase.files.map(&:file_ref)
  return ref if files.include?(ref)

  if phase.respond_to?(:add_file_reference)
    phase.add_file_reference(ref)
  else
    target.add_file_references([ref])
  end
  ref
end

bridge_path = File.join(ROOT, 'ios', 'App', APP_SOURCE_DIR, BRIDGE_SWIFT)
if File.exist?(bridge_path)
  add_file_once(app_group, app, BRIDGE_SWIFT, app.source_build_phase)
  puts "[watch] App ターゲットに #{BRIDGE_SWIFT} を追加"
else
  puts '[watch] 警告: WatchBridgePlugin.swift が見つかりません（configure-watch.js を先に実行）'
end

sound_path = File.join(ROOT, 'ios', 'App', APP_SOURCE_DIR, SILENT_SOUND)
if File.exist?(sound_path)
  resources_phase = app.resources_build_phase
  add_file_once(app_group, app, SILENT_SOUND, resources_phase)
  puts "[watch] App ターゲットに #{SILENT_SOUND}（無音通知音）を追加"
end

# ---------------------------------------------------------------- Watch ターゲット
watch = project.targets.find { |t| t.name == WATCH_TARGET_NAME }
if watch.nil?
  watch = project.new_target(:application, WATCH_TARGET_NAME, :watchos, WATCHOS_DEPLOYMENT_TARGET)
  puts "[watch] ターゲット作成: #{WATCH_TARGET_NAME}"
end

# 現代のWatchアプリは product-type.application + SDKROOT=watchos（旧 watchapp2 ではない）
watch.product_type = 'com.apple.product-type.application'
# new_target が入れる Foundation リンクは不要
watch.frameworks_build_phase.files.clear

group = project.main_group.find_subpath(WATCH_SOURCE_DIR, true)
group.set_source_tree('<group>')

watch_source_abs = File.join(ROOT, 'ios', 'App', WATCH_SOURCE_DIR)
swift_files = Dir.glob(File.join(watch_source_abs, '*.swift')).sort
abort("[watch] Watch source not found in #{watch_source_abs}") if swift_files.empty?

swift_files.each do |abs|
  name = File.basename(abs)
  existing = group.children.find { |child| child.path == name }
  ref = existing || group.new_file(name)
  watch.add_file_references([ref]) unless watch.source_build_phase.files.map(&:file_ref).include?(ref)
end

plist_path = File.join(watch_source_abs, 'Info.plist')
abort('[watch] Info.plist not found') unless File.exist?(plist_path)
group.new_file('Info.plist') if group.children.none? { |child| child.path == 'Info.plist' }

assets_path = File.join(watch_source_abs, 'Assets.xcassets')
if File.exist?(assets_path)
  existing = group.children.find { |child| child.path == 'Assets.xcassets' }
  ref = existing || group.new_file('Assets.xcassets')
  watch.add_resources([ref]) unless watch.resources_build_phase.files.map(&:file_ref).include?(ref)
else
  puts '[watch] 警告: WatchのAssets.xcassets が無い（アイコン未設定でアップロード検証に落ちる可能性）'
end

# ---------------------------------------------------------------- ビルド設定
watch.build_configurations.each do |config|
  bs = config.build_settings
  bs['SDKROOT'] = 'watchos'
  bs['SUPPORTED_PLATFORMS'] = 'watchos watchsimulator'
  bs['TARGETED_DEVICE_FAMILY'] = '4'
  bs['SKIP_INSTALL'] = 'YES'
  bs['WATCHOS_DEPLOYMENT_TARGET'] = WATCHOS_DEPLOYMENT_TARGET
  bs['PRODUCT_BUNDLE_IDENTIFIER'] = WATCH_BUNDLE_ID
  bs['PRODUCT_NAME'] = '$(TARGET_NAME)'
  bs['INFOPLIST_FILE'] = "#{WATCH_SOURCE_DIR}/Info.plist"
  bs['GENERATE_INFOPLIST_FILE'] = 'NO'
  bs['ASSETCATALOG_COMPILER_APPICON_NAME'] = 'AppIcon'
  bs['SWIFT_VERSION'] = '5.0'
  bs['MARKETING_VERSION'] = APP_MARKETING_VERSION
  bs['CURRENT_PROJECT_VERSION'] = APP_BUILD_NUMBER
  bs['CODE_SIGN_STYLE'] = 'Automatic'
  bs['DEVELOPMENT_TEAM'] = ENV.fetch('DEVELOPMENT_TEAM', '$(DEVELOPMENT_TEAM)')
  bs['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks']
  bs['SWIFT_EMIT_LOC_STRINGS'] = 'YES'
  bs['ENABLE_PREVIEWS'] = 'YES'
  bs['APPLICATION_EXTENSION_API_ONLY'] = 'NO'
  bs['INFOPLIST_KEY_CFBundleDisplayName'] = WATCH_DISPLAY_NAME
  bs['INFOPLIST_KEY_WKCompanionAppBundleIdentifier'] = COMPANION_BUNDLE_ID
end

# ---------------------------------------------------------------- 依存関係と埋め込み
unless app.dependencies.any? { |dependency| dependency.target == watch }
  app.add_dependency(watch)
end

def embed_options(mode)
  if mode == 'plugins'
    { spec: :plug_ins, path: '' }
  else
    { spec: :products_directory, path: '$(CONTENTS_FOLDER_PATH)/Watch' }
  end
end

opts = embed_options(EMBED_MODE)
phase = app.copy_files_build_phases.find { |item| item.name == 'Embed Watch Content' }
phase ||= app.new_copy_files_build_phase('Embed Watch Content')
phase.symbol_dst_subfolder_spec = opts[:spec]
phase.dst_path = opts[:path]
unless phase.files_references.include?(watch.product_reference)
  phase.add_file_reference(watch.product_reference, true)
end

# 「Thin Binary」より前に置かないと "Cycle inside App" になることがある
phases = app.build_phases
embed_index = phases.index(phase)
if embed_index
  thin = phases.find { |item| item.display_name == 'Thin Binary' }
  thin_index = thin ? phases.index(thin) : nil
  if thin_index && embed_index > thin_index
    phases.delete(phase)
    phases.insert(thin_index, phase)
  end
end

project.save
puts "[watch] target=#{WATCH_TARGET_NAME} bundle=#{WATCH_BUNDLE_ID} embed=#{EMBED_MODE} -> 保存完了"