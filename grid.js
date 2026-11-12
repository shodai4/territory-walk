/**
 * TERRITORY WALK - grid.js
 * 100m Mesh Grid Calculation & Layer Render Module
 * ナスカの地上絵モード：未開拓空マス描画を全廃し、塗られたマスのみを描画することで
 * 日本全体・広域ズーム（zoom 1〜22）でもスマホで超軽量・高速描画を実現
 */

class GridManager {
    constructor(mapInstance, appInstance) {
        this.map = mapInstance;
        this.app = appInstance;
        this.gridLayerGroup = L.layerGroup().addTo(this.map);
        this.renderedMeshes = new Map();
        this.claimedTilesCache = new Map();

        this.LAT_GRID = 0.0009; // 約100m四方の緯度グリッド（固定）
        // 日本（本州・関西〜関東 緯度約35.0度）を基準とする固定経度グリッド幅
        // 緯度ごとに動的計算すると上下行間で経度境界がズレてレンガ積み状になるため、
        // 経度グリッド幅を一律固定定数化して完全な直交格子（チェス盤・オセロ盤）を実現
        this.BASE_LAT = 35.0; // 日本基準緯度
        this.LNG_GRID = this.LAT_GRID / Math.cos(this.BASE_LAT * Math.PI / 180); // 約0.00109868度

        this.checkWeekReset();
        this.loadTilesFromStorage();
        this.initEventListeners();
        this.updateGrids();
    }

    getMeshIndices(lat, lng) {
        const latIdx = Math.floor(lat / this.LAT_GRID);
        const lngIdx = Math.floor(lng / this.LNG_GRID);
        return { latIdx, lngIdx };
    }

    getMeshBounds(latIdx, lngIdx) {
        const south = latIdx * this.LAT_GRID;
        const north = (latIdx + 1) * this.LAT_GRID;
        const west = lngIdx * this.LNG_GRID;
        const east = (lngIdx + 1) * this.LNG_GRID;

        return L.latLngBounds([south, west], [north, east]);
    }

    getMeshId(latIdx, lngIdx) {
        return `${latIdx}_${lngIdx}`;
    }

    getMeshIdFromLatLng(lat, lng) {
        const { latIdx, lngIdx } = this.getMeshIndices(lat, lng);
        return { meshId: this.getMeshId(latIdx, lngIdx), latIdx, lngIdx };
    }

    checkWeekReset() {
        const currentWeek = this.app?.supabaseManager?.getCurrentWeekId() || 'default-week';
        const savedWeek = localStorage.getItem('territory_saved_week');
        const gridVersion = localStorage.getItem('territory_grid_version');

        // グリッド計算式更新（チェス盤完全格子化 v2）または週リセット時にキャッシュクリア
        if ((savedWeek && savedWeek !== currentWeek) || gridVersion !== 'v2_fixed_grid') {
            localStorage.removeItem('territory_claimed_tiles');
            this.claimedTilesCache.clear();
            this.gridLayerGroup.clearLayers();
            this.renderedMeshes.clear();
        }
        localStorage.setItem('territory_saved_week', currentWeek);
        localStorage.setItem('territory_grid_version', 'v2_fixed_grid');
    }

    loadTilesFromStorage() {
        try {
            const saved = localStorage.getItem('territory_claimed_tiles');
            if (saved) {
                const obj = JSON.parse(saved);
                for (const [k, v] of Object.entries(obj)) {
                    if (v === 'white' || v === 'black') {
                        this.claimedTilesCache.set(k, v);
                    }
                }
            }
        } catch (e) {
            console.warn('Failed to load tiles from localStorage:', e);
        }
    }

    saveTilesToStorage() {
        try {
            const obj = {};
            for (const [k, v] of this.claimedTilesCache.entries()) {
                obj[k] = v;
            }
            localStorage.setItem('territory_claimed_tiles', JSON.stringify(obj));
        } catch (e) {
            console.warn('Failed to save tiles to localStorage:', e);
        }
    }

    initEventListeners() {
        let throttleTimer = null;
        const onMapChange = () => {
            if (throttleTimer) return;
            throttleTimer = setTimeout(() => {
                this.updateGrids();
                throttleTimer = null;
            }, 100);
        };

        this.map.on('moveend', onMapChange);
        this.map.on('zoomend', onMapChange);
    }

    async fetchAndSyncTiles() {
        if (!this.app || !this.app.supabaseManager) return;

        try {
            const bounds = this.map.getBounds();
            const tiles = await this.app.supabaseManager.fetchTilesInBounds(
                bounds.getSouth(),
                bounds.getNorth(),
                bounds.getWest(),
                bounds.getEast()
            );

            let updated = false;
            if (Array.isArray(tiles)) {
                tiles.forEach(tile => {
                    if (tile && tile.tile_id && tile.team) {
                        if (this.claimedTilesCache.get(tile.tile_id) !== tile.team) {
                            this.claimedTilesCache.set(tile.tile_id, tile.team);
                            updated = true;
                        }
                    }
                });
            }

            if (updated) {
                this.saveTilesToStorage();
                if (this.app.updateScoreUI) {
                    this.app.updateScoreUI();
                }
            }
        } catch (e) {
            console.warn('Tile sync failed or running offline:', e);
        }
    }

    /**
     * 広域ズーム（ナスカの地上絵モード）対応グリッド更新
     * 空マスは一切生成せず、開拓済みタイルのみを高速描画
     */
    async updateGrids() {
        await this.fetchAndSyncTiles();

        const bounds = this.map.getBounds().pad(0.2);
        const currentZoom = this.map.getZoom();
        const isDistant = currentZoom < 13;
        const activeMeshIds = new Set();

        for (const [meshId, team] of this.claimedTilesCache.entries()) {
            if (team !== 'white' && team !== 'black') continue;

            const [latIdxStr, lngIdxStr] = meshId.split('_');
            const latIdx = parseInt(latIdxStr, 10);
            const lngIdx = parseInt(lngIdxStr, 10);
            const meshBounds = this.getMeshBounds(latIdx, lngIdx);

            // 画面内に入るマスのみ描画（引きズーム時は広範囲が全て対象になる）
            if (bounds.intersects(meshBounds)) {
                activeMeshIds.add(meshId);
                const style = this.getTileStyle(team, currentZoom);

                if (this.renderedMeshes.has(meshId)) {
                    const rect = this.renderedMeshes.get(meshId);
                    if (rect._team !== team || rect._isDistant !== isDistant) {
                        rect.setStyle(style);
                        rect._team = team;
                        rect._isDistant = isDistant;
                    }
                } else {
                    const rect = L.rectangle(meshBounds, style);
                    rect._team = team;
                    rect._isDistant = isDistant;
                    this.gridLayerGroup.addLayer(rect);
                    this.renderedMeshes.set(meshId, rect);
                }
            }
        }

        // 画面外に外れたマスをクリーンアップ
        for (const [meshId, rect] of this.renderedMeshes.entries()) {
            if (!activeMeshIds.has(meshId)) {
                this.gridLayerGroup.removeLayer(rect);
                this.renderedMeshes.delete(meshId);
            }
        }
    }

    /**
     * 白マス・黒マスのスタイル定義
     * 地図ON（ダーク反転）時も地図OFF（漆黒）時もオセロのように鮮明に際立つ境界線と配色
     */
    getTileStyle(team, currentZoom = 16) {
        const isDistant = currentZoom < 13;
        const strokeWidth = isDistant ? 0.8 : 1.5;

        if (team === 'white') {
            return {
                color: '#000000', // 白マスにクッキリした黒枠（オセロ白コマ調）
                weight: strokeWidth,
                opacity: 1.0,
                fillColor: '#ffffff',
                fillOpacity: 0.92,
                interactive: false
            };
        } else if (team === 'black') {
            return {
                color: '#71717a', // 黒マスにZinc-500の明るい輪郭枠（ダーク背景でも埋もれない）
                weight: strokeWidth,
                opacity: 1.0,
                fillColor: '#09090b',
                fillOpacity: 0.95,
                interactive: false
            };
        }
        return null;
    }

    renderSingleTile(meshId, team) {
        const [latIdxStr, lngIdxStr] = meshId.split('_');
        const latIdx = parseInt(latIdxStr, 10);
        const lngIdx = parseInt(lngIdxStr, 10);
        const meshBounds = this.getMeshBounds(latIdx, lngIdx);
        const currentZoom = this.map.getZoom();
        const style = this.getTileStyle(team, currentZoom);

        if (this.renderedMeshes.has(meshId)) {
            const rect = this.renderedMeshes.get(meshId);
            rect.setStyle(style);
            rect._team = team;
            rect._isDistant = currentZoom < 13;
        } else {
            const rect = L.rectangle(meshBounds, style);
            rect._team = team;
            rect._isDistant = currentZoom < 13;
            this.gridLayerGroup.addLayer(rect);
            this.renderedMeshes.set(meshId, rect);
        }
    }

    async onPlayerStep(lat, lng) {
        if (!this.app) return;

        const { meshId, latIdx, lngIdx } = this.getMeshIdFromLatLng(lat, lng);
        const currentTeam = this.app.currentTeam;

        if (this.claimedTilesCache.get(meshId) === currentTeam) {
            return;
        }

        this.claimedTilesCache.set(meshId, currentTeam);
        this.renderSingleTile(meshId, currentTeam);
        this.saveTilesToStorage();

        if (this.app.playClaimSound) {
            this.app.playClaimSound();
        }
        if (this.app.triggerHaptic) {
            this.app.triggerHaptic();
        }
        if (this.app.updateScoreUI) {
            this.app.updateScoreUI();
        }

        if (this.app.supabaseManager) {
            try {
                await this.app.supabaseManager.claimTile(meshId, latIdx, lngIdx, currentTeam);
            } catch (err) {
                console.warn('Supabase claimTile offline/error:', err);
            }
        }
    }
}
