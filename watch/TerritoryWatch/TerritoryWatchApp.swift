//
//  TerritoryWatchApp.swift
//  TERRITORY WALK Watch App（コンパニオン版 Phase 1）
//
//  画面は2要素だけに絞る（ユーザー指示: ①地図＋陣地マス ②マーキングON/OFF）。
//  ズームは画面の ＋／－ ボタンを廃止し、Digital Crown（リューズ）を回して4段階で切り替える。
//  マスの色は iPhone 側で解決済みの値をそのまま描く（初期配置・実績で見分けは付けない）。
//

import SwiftUI
import MapKit          // Map / MapPolygon / MapCircle / .mapStyle は MapKit の SwiftUI API
import WatchKit

struct ContentView: View {
    @StateObject private var model = WatchModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack(alignment: .bottom) {
            Map(position: $model.camera, interactionModes: []) {
                ForEach(model.visibleCells) { cell in
                    MapPolygon(coordinates: Grid.corners(latIdx: cell.latIdx, lngIdx: cell.lngIdx))
                        .foregroundStyle(color(for: cell.team).opacity(fillOpacity(for: cell.team)))
                        .stroke(strokeColor(for: cell.team), lineWidth: strokeWidth(for: cell.team))
                }
                if let me = model.meCoordinate {
                    MapCircle(center: me, radius: 12)
                        .foregroundStyle(.white.opacity(0.9))
                }
            }
            .mapStyle(.standard(pointsOfInterest: .excludingAll))
            .mapControlVisibility(.hidden)
            // 白黒の陣地マスが映えるよう、地図自体は彩度を落としたモノトーン寄りにする
            .saturation(0.0)
            .colorScheme(.dark)
            .ignoresSafeArea()

            // iPhone とまだ繋がっていない時の案内（画面の要素は増やさない）
            if !model.hasWindow {
                VStack(spacing: 4) {
                    Image(systemName: "iphone.radiowaves.left.and.right")
                        .font(.system(size: 18, weight: .bold))
                    Text("iPhoneと接続中")
                        .font(.system(size: 10, weight: .semibold))
                    // 10秒たっても届かないときだけ、次にやることを1行だけ出す
                    if model.showHint {
                        Text("iPhoneのアプリを開いてね")
                            .font(.system(size: 9))
                            .opacity(0.8)
                    }
                }
                .foregroundStyle(.white.opacity(0.9))
                .padding(.bottom, 44)
            }

            // 操作ボタンはマーキング ON/OFF だけ（ズームは Digital Crown）
            VStack(spacing: 6) {
                Spacer()

                Button {
                    model.toggleMarking()
                } label: {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(model.marking ? Color.white : Color.gray)
                            .frame(width: 8, height: 8)
                        Text(model.marking ? "マーキング ON" : "停止中")
                            .font(.system(size: 12, weight: .bold))
                    }
                    .frame(maxWidth: .infinity, minHeight: 40)
                    .background(model.marking ? Color.white.opacity(0.18) : Color.black.opacity(0.55))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12)
                            .stroke(model.marking ? Color.white.opacity(0.8) : Color.gray.opacity(0.6),
                                    lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 6)
                .padding(.bottom, 4)
                .disabled(!model.reachable)
                .opacity(model.reachable ? 1 : 0.55)
            }
        }
        // Digital Crown でズーム（上へ回す＝拡大、下へ回す＝広げる）。
        // by: 1.0 で4段階にスナップし、段が変わったときだけモデルが窓を取り直す。
        .focusable(true)
        .focusEffectDisabled()
        .digitalCrownRotation(
            crownBinding,
            from: 0,
            to: Double(model.maxZoomIndex),
            by: 1.0,
            sensitivity: .low,
            isContinuous: false,
            isHapticFeedbackEnabled: true
        )
        // 画面がアクティブに戻るたびに取り直す（iPhone が起きていれば即同期）
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                model.onForeground()
            }
        }
    }

    /// Digital Crown の値（0＝最も広い … maxZoomIndex＝最も拡大）。
    /// 上へ回すと値が増える＝拡大方向になるよう、モデル側で zoomIndex と逆向きに持つ。
    private var crownBinding: Binding<Double> {
        Binding(
            get: { model.crownPosition },
            set: { model.setCrownPosition($0) }
        )
    }

    /// 陣営の色（Watch も白黒で統一: 白チーム＝白 / 黒チーム＝黒）。
    /// 1 = 白チーム、2 = 黒チーム（watch-bridge.js の送信形式）。
    private func color(for team: Int) -> Color {
        team == 1 ? .white : .black
    }

    /// 暗いモノトーン地図の上で黒マスが埋もれないよう、黒マスは白寄りの細い縁取りを付ける
    private func strokeColor(for team: Int) -> Color {
        team == 1 ? Color.gray.opacity(0.6) : Color.white.opacity(0.45)
    }

    private func strokeWidth(for team: Int) -> CGFloat {
        team == 1 ? 0.6 : 0.7
    }

    /// 塗りつぶしの濃さ。白マスは地図の明るい場所でも沈まないよう濃さを揃える
    private func fillOpacity(for team: Int) -> Double {
        team == 1 ? 0.5 : 0.6
    }
}

@main
struct TerritoryWatchApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
