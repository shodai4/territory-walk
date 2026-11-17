//
//  TerritoryWatchApp.swift
//  TERRITORY WALK Watch App（コンパニオン版 Phase 1）
//
//  画面は3要素だけに絞る（ユーザー指示: ①地図＋陣地マス ②＋／－ ③マーキングON/OFF）。
//  マスの色は iPhone 側で解決済みの値をそのまま描く（初期配置・実績で見分けは付けない）。
//

import SwiftUI
import MapKit          // Map / MapPolygon / MapCircle / .mapStyle は MapKit の SwiftUI API
import WatchKit

struct ContentView: View {
    @StateObject private var model = WatchModel()

    var body: some View {
        ZStack(alignment: .bottom) {
            Map(position: $model.camera, interactionModes: []) {
                ForEach(model.visibleCells) { cell in
                    MapPolygon(coordinates: Grid.corners(latIdx: cell.latIdx, lngIdx: cell.lngIdx))
                        .foregroundStyle(color(for: cell.team).opacity(0.45))
                        .stroke(color(for: cell.team).opacity(0.55), lineWidth: 0.6)
                }
                if let me = model.meCoordinate {
                    MapCircle(center: me, radius: 12)
                        .foregroundStyle(.white.opacity(0.9))
                }
            }
            .mapStyle(.standard(pointsOfInterest: .excludingAll))
            .mapControlVisibility(.hidden)
            .ignoresSafeArea()

            // iPhone とまだ繋がっていない時の案内（3要素は増やさない）
            if !model.hasWindow {
                VStack(spacing: 4) {
                    Image(systemName: "iphone.radiowaves.left.and.right")
                        .font(.system(size: 18, weight: .bold))
                    Text("iPhoneと接続中")
                        .font(.system(size: 10, weight: .semibold))
                }
                .foregroundStyle(.white.opacity(0.9))
                .padding(.bottom, 44)
            }

            VStack(spacing: 6) {
                HStack {
                    Spacer()
                    VStack(spacing: 6) {
                        zoomButton("plus", enabled: model.canZoomIn) { model.zoomIn() }
                        zoomButton("minus", enabled: model.canZoomOut) { model.zoomOut() }
                    }
                    .padding(.trailing, 6)
                }
                .padding(.top, 18)

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
    }

    /// 黒チームを黒で塗ると地図上で見えないため、Watchではアンバーで表現する
    private func color(for team: Int) -> Color {
        team == 1 ? .white : .orange
    }

    private func zoomButton(_ symbol: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .bold))
                .frame(width: 34, height: 34)
                .background(Color.black.opacity(0.55))
                .overlay(Circle().stroke(Color.white.opacity(0.7), lineWidth: 1))
                .clipShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
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
