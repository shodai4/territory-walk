/**
 * TERRITORY WALK - grid.js
 * 100m Quad Mesh Calculation, Tile State Management, Dynamic Styling & Leaflet Grid Layer
 *
 * v1.1 プライバシー設計:
 *   1. DBに無いマスは week_id + 座標の決定論的ハッシュで白 / 黒 50%:50% の「初期配置」として表示する
 *      （全ユーザーが同じ座標で同じ色を見る。DB容量ゼロ・週が変われば自動でシャッフル）。
 *   2. 塗りは半透明にして下の地図（道路・駅名・建物）を読める濃さにする。
 *   3. 自分が今週踏んで塗ったマスだけ、自分の端末で細い枠線（足跡）を付ける。サーバーには送らない。
 *   4. 非表示ピン（privacy.js）の区域の中は、自分の画面でも初期配置の見た目に戻す。
 */

/** 塗りの濃さ（初期配置・実際に塗ったマスで同じにする＝見分けが付かない） */
const TILE_FILL_OPACITY = 0.45;
const TILE_STROKE_OPACITY = 0.55;
const TILE_STROKE_WEIGHT = 1.2;
/** 自分の足跡（今週踏んだマス）だけに付ける枠線 */
const FOOTPRINT_STROKE_COLOR = '#f59e0b';
const FOOTPRINT_STROKE_WEIGHT = 2.4;
const FOOTPRINT_STROKE_OPACITY = 0.95;
/** 自分の足跡の保存キー（端末内のみ） */
const FOOTPRINT_STORAGE_KEY = 'tw_footprint';
const FOOTPRINT_MAX_TILES = 3000;

/**
 * Asia/Tokyo の ISO 週（例: 2026-W47）。
 * SupabaseManager が無い場面（テスト・オフライン）でも初期配置を同じ色にするために使う。
 */
function isoWeekIdJst(date = new Date()) {
    const jstString = date.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' });
    const jstDate = new Date(jstString);
    const target = new Date(jstDate.valueOf());
    const dayNum = (jstDate.getDay() + 6) % 7; // Monday = 0
    target.setDate(target.getDate() - dayNum + 3);
    const firstThursday = new Date(target.getFullYear(), 0, 4);
    const firstThursdayDayNum = (firstThursday.getDay() + 6) % 7;
    firstThursday.setDate(firstThursday.getDate() - firstThursdayDayNum + 3);
    const weekNum = Math.round(((target - firstThursday) / 86400000 - 3) / 7) + 1;
    return `${target.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * マス座標と週から決まる 32bit ハッシュ（FNV-1a + 攪拌）。
 * 同じ week_id・同じ座標なら、誰の端末でも必ず同じ値になる。
 */
function tileHash(weekId, latIdx, lngIdx) {
    const text = `${weekId}:${latIdx}:${lngIdx}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d) >>> 0;
    h ^= h >>> 12;
    h = Math.imul(h, 0x297a2d39) >>> 0;
    h ^= h >>> 15;
    return h >>> 0;
}

/** 未登録マスの初期配置（white / black を 50%:50% で決める） */
function deterministicInitialTeam(weekId, latIdx, lngIdx) {
    return (tileHash(weekId, latIdx, lngIdx) & 1) === 1 ? 'white' : 'black';
}

class GridManager {
    constructor(map, appInstance) {
        this.map = map;
        this.app = appInstance;

        // Base 100m mesh constants for Japan (Latitude ~35.0 deg)
        this.LAT_GRID = 0.0009; // ~100m in latitude
        this.LNG_GRID = this.LAT_GRID / Math.cos(35.0 * Math.PI / 180); // ~0.00109868 degrees in longitude

        // In-memory cache for fast lookup
        this.claimedTilesCache = new Map(); // meshId -> 'white' | 'black'
        this.renderedMeshes = new Map();     // meshId -> L.Rectangle layer

        // 自分の足跡（今週踏んだマス）。端末内のみ・サーバーへは送らない
        this.footprintWeek = null;
        this.footprintIds = [];
        this.footprintSet = new Set();

        // 初期配置の色を決める週（週明けに更新される）
        this.weekId = null;

        // Use Canvas renderer for low memory footprint and high 60fps performance
        this.canvasRenderer = (typeof L !== 'undefined' && L.canvas) ? L.canvas({ padding: 0.5 }) : null;
        this.gridLayerGroup = L.layerGroup().addTo(this.map);

        this.checkWeekReset();
        this.loadTilesFromStorage();
        this.loadFootprint();
        this.initEventListeners();
    }

    /**
     * Compute integer mesh indices (latIdx, lngIdx) from lat/lng
     */
    getMeshIndices(lat, lng) {
        const latIdx = Math.floor(lat / this.LAT_GRID);
        const lngIdx = Math.floor(lng / this.LNG_GRID);
        return { latIdx, lngIdx };
    }

    /**
     * Compute bounding box for a given mesh coordinate
     */
    getMeshBounds(latIdx, lngIdx) {
        const south = latIdx * this.LAT_GRID;
        const north = south + this.LAT_GRID;
        const west = lngIdx * this.LNG_GRID;
        const east = west + this.LNG_GRID;
        return [[south, west], [north, east]];
    }

    /** マスの中心座標（非表示ピンの内外判定に使う） */
    getMeshCenter(latIdx, lngIdx) {
        return {
            lat: (latIdx + 0.5) * this.LAT_GRID,
            lng: (lngIdx + 0.5) * this.LNG_GRID
        };
    }

    getMeshId(latIdx, lngIdx) {
        return `tile_${latIdx}_${lngIdx}`;
    }

    getMeshIdFromLatLng(lat, lng) {
        const { latIdx, lngIdx } = this.getMeshIndices(lat, lng);
        return { meshId: this.getMeshId(latIdx, lngIdx), latIdx, lngIdx };
    }

    /** 現在の週ID（初期配置のハッシュ種） */
    getWeekId() {
        if (this.app && this.app.supabaseManager) {
            this.weekId = this.app.supabaseManager.getCurrentWeekId();
        } else if (!this.weekId) {
            this.weekId = isoWeekIdJst();
        }
        return this.weekId || isoWeekIdJst();
    }

    checkWeekReset() {
        const currentWeek = this.getWeekId();
        const savedWeek = localStorage.getItem('territory_current_week');

        if (savedWeek && savedWeek !== currentWeek) {
            console.log(`Weekly reset detected: ${savedWeek} -> ${currentWeek}`);
            localStorage.removeItem('territory_claimed_tiles');
            this.claimedTilesCache.clear();
            // 足跡も週が変われば意味がないので消す（初期配置の枠線が残らないように）
            this.footprintIds = [];
            this.footprintSet = new Set();
            this.footprintWeek = currentWeek;
            this.saveFootprint();
        }
        localStorage.setItem('territory_current_week', currentWeek);
    }

    loadTilesFromStorage() {
        try {
            const raw = localStorage.getItem('territory_claimed_tiles');
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    parsed.forEach(([id, team]) => {
                        if (team === 'white' || team === 'black') {
                            this.claimedTilesCache.set(id, team);
                        }
                    });
                }
            }
        } catch (e) {
            console.warn('Failed to load tiles from localStorage:', e);
        }
    }

    saveTilesToStorage() {
        try {
            const arr = Array.from(this.claimedTilesCache.entries());
            localStorage.setItem('territory_claimed_tiles', JSON.stringify(arr));
        } catch (e) {
            console.warn('Failed to save tiles to localStorage:', e);
        }
    }

    /* ---------------- 自分の足跡（端末内のみ） ---------------- */

    loadFootprint() {
        const week = this.getWeekId();
        this.footprintWeek = week;
        try {
            const raw = localStorage.getItem(FOOTPRINT_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (parsed && parsed.week === week && Array.isArray(parsed.ids)) {
                this.footprintIds = parsed.ids.filter((id) => typeof id === 'string');
                this.footprintSet = new Set(this.footprintIds);
            }
        } catch (e) {
            this.footprintIds = [];
            this.footprintSet = new Set();
        }
    }

    saveFootprint() {
        try {
            localStorage.setItem(FOOTPRINT_STORAGE_KEY, JSON.stringify({
                week: this.footprintWeek || this.getWeekId(),
                ids: this.footprintIds
            }));
        } catch (e) {
            console.warn('Failed to save footprint:', e);
        }
    }

    /** 自分が今週塗ったマスを記録する（描画の枠線だけで、サーバーには送らない） */
    recordFootprint(meshId) {
        if (!meshId) return;
        const week = this.getWeekId();
        if (this.footprintWeek !== week) {
            this.footprintWeek = week;
            this.footprintIds = [];
            this.footprintSet = new Set();
        }
        if (this.footprintSet.has(meshId)) return;
        this.footprintSet.add(meshId);
        this.footprintIds.push(meshId);
        if (this.footprintIds.length > FOOTPRINT_MAX_TILES) {
            const overflow = this.footprintIds.length - FOOTPRINT_MAX_TILES;
            const removed = this.footprintIds.splice(0, overflow);
            removed.forEach((id) => this.footprintSet.delete(id));
        }
        this.saveFootprint();
    }

    isOwnFootprint(meshId) {
        if (!meshId || this.footprintWeek !== this.getWeekId()) return false;
        return this.footprintSet.has(meshId);
    }

    /* ---------------- 初期配置・非表示ピンを含めたマスの解決 ---------------- */

    /** その座標が非表示ピンの中か（入っていれば region） */
    getPrivacyZone(latIdx, lngIdx) {
        const manager = this.app ? this.app.privacyZones : null;
        if (!manager || typeof manager.containsMesh !== 'function') return null;
        return manager.containsMesh(latIdx, lngIdx, this);
    }

    /**
     * 画面に描く色を決める唯一の入口。
     *   1) 非表示ピンの区域 → 初期配置（実際に塗られていても見せない）
     *   2) サーバー/ローカルの実績 → その陣営
     *   3) 未登録 → week_id + 座標のハッシュ（白 / 黒 50:50）
     */
    resolveTileTeam(meshId, latIdx, lngIdx) {
        if (this.getPrivacyZone(latIdx, lngIdx)) {
            return deterministicInitialTeam(this.getWeekId(), latIdx, lngIdx);
        }
        const claimed = this.claimedTilesCache.get(meshId);
        if (claimed === 'white' || claimed === 'black') return claimed;
        return deterministicInitialTeam(this.getWeekId(), latIdx, lngIdx);
    }

    /** そのマスに実際の記録（誰かが塗った陣地）があるか */
    hasClaim(meshId) {
        const team = this.claimedTilesCache.get(meshId);
        return team === 'white' || team === 'black';
    }

    initEventListeners() {
        let throttleTimer = null;
        const onMapChange = () => {
            if (throttleTimer) return;
            throttleTimer = setTimeout(() => {
                this.updateGrids();
                this.fetchAndSyncTiles();
                throttleTimer = null;
            }, 100);
        };

        this.map.on('moveend', onMapChange);
        this.map.on('zoomend', onMapChange);
    }

    /**
     * Sync remote tiles within visible bounds from Supabase
     */
    async fetchAndSyncTiles() {
        if (!this.app || !this.app.supabaseManager) return;

        // 広域表示（低ズーム）では取得しない：大範囲クエリによるDB負荷・描画負荷を防ぐ
        const zoom = this.map ? this.map.getZoom() : 0;
        const minZoom = (typeof CONFIG !== 'undefined' && CONFIG.REMOTE_FETCH_MIN_ZOOM) ? CONFIG.REMOTE_FETCH_MIN_ZOOM : 12;
        if (zoom < minZoom) return;

        try {
            const bounds = this.map.getBounds();
            const tiles = await this.app.supabaseManager.fetchTilesInBounds(
                bounds.getSouth(),
                bounds.getNorth(),
                bounds.getWest(),
                bounds.getEast()
            );

            if (tiles && tiles.length > 0) {
                let updated = false;
                // 未送信（Outbox待ち）のローカル陣地はリモート値で上書きしない
                const pendingMeshes = (this.app && this.app.syncQueue)
                    ? this.app.syncQueue.pendingMeshIds()
                    : new Set();
                tiles.forEach(tile => {
                    if (pendingMeshes.has(tile.tile_id)) return;
                    // デバッグの白紙リセット直後：削除したマスを古い取得結果で戻さない
                    if (this.isRecentlyReset(tile.tile_id)) return;
                    if (this.claimedTilesCache.get(tile.tile_id) !== tile.team) {
                        this.claimedTilesCache.set(tile.tile_id, tile.team);
                        updated = true;
                    }
                });
                if (updated) {
                    this.updateGrids();
                    this.saveTilesToStorage();
                    if (this.app) this.app.updateScoreUI();
                }
            }
        } catch (e) {
            console.warn('Failed to sync remote tiles:', e);
        }
    }

    /**
     * デバッグの白紙リセット直後か（削除済みマスを再マージしないための判定）
     */
    isRecentlyReset(tileId) {
        const reset = this.app && this.app.territoryReset;
        if (!reset || !reset.ids) return false;
        if (Date.now() - reset.at > 60000) return false;
        return reset.ids.has(tileId);
    }

    /**
     * Get style definition for tile based on team and current active skin
     * @param {'white'|'black'|null} team
     * @param {{ ownFootprint?: boolean }} [options]
     */
    getTileStyle(team, options = {}) {
        const skin = document.body.dataset.skin || 'default';
        const styles = {
            default: {
                white: { color: '#000000', weight: 1.5, fillOpacity: 0.85, fillColor: '#ffffff' },
                black: { color: '#71717a', weight: 1.5, fillOpacity: 0.90, fillColor: '#09090b' },
                unclaimed: { color: '#3f3f46', weight: 1, fillOpacity: 0.02, fillColor: '#ffffff' }
            },
            neon: {
                white: { color: '#083344', weight: 1.5, fillOpacity: 0.85, fillColor: '#06b6d4' },
                black: { color: '#4a044e', weight: 1.5, fillOpacity: 0.85, fillColor: '#d946ef' },
                unclaimed: { color: '#334155', weight: 1, fillOpacity: 0.05, fillColor: '#1e293b' }
            },
            gold: {
                white: { color: '#ca8a04', weight: 1.5, fillOpacity: 0.85, fillColor: '#fef08a' },
                black: { color: '#eab308', weight: 1.5, fillOpacity: 0.90, fillColor: '#18181b' },
                unclaimed: { color: '#71717a', weight: 1, fillOpacity: 0.05, fillColor: '#27272a' }
            },
            crimson: {
                white: { color: '#9a3412', weight: 1.5, fillOpacity: 0.85, fillColor: '#fb923c' },
                black: { color: '#991b1b', weight: 1.5, fillOpacity: 0.88, fillColor: '#ef4444' },
                unclaimed: { color: '#431407', weight: 1, fillOpacity: 0.05, fillColor: '#1c1917' }
            },
            sakura: {
                white: { color: '#0f766e', weight: 1.5, fillOpacity: 0.85, fillColor: '#2dd4bf' },
                black: { color: '#be185d', weight: 1.5, fillOpacity: 0.85, fillColor: '#f472b6' },
                unclaimed: { color: '#831843', weight: 1, fillOpacity: 0.05, fillColor: '#18181b' }
            },
            pixel: {
                white: { color: '#3f6212', weight: 1.5, fillOpacity: 0.85, fillColor: '#bef264' },
                black: { color: '#14532d', weight: 1.5, fillOpacity: 0.85, fillColor: '#365314' },
                unclaimed: { color: '#4d7c0f', weight: 1, fillOpacity: 0.08, fillColor: '#365314' }
            },
            cyberpunk: {
                white: { color: '#0284c7', weight: 1.5, fillOpacity: 0.88, fillColor: '#38bdf8' },
                black: { color: '#7e22ce', weight: 1.5, fillOpacity: 0.90, fillColor: '#a855f7' },
                unclaimed: { color: '#581c87', weight: 1, fillOpacity: 0.05, fillColor: '#3b0764' }
            },
            monochrome: {
                white: { color: '#1e293b', weight: 1.5, fillOpacity: 0.88, fillColor: '#f1f5f9' },
                black: { color: '#020617', weight: 1.5, fillOpacity: 0.92, fillColor: '#334155' },
                unclaimed: { color: '#1e293b', weight: 1, fillOpacity: 0.05, fillColor: '#0f172a' }
            }
        };

        const theme = styles[skin] || styles.default;
        const base = team === 'white' ? theme.white : (team === 'black' ? theme.black : theme.unclaimed);

        // 塗りは「下の地図が読める濃さ」に統一する。
        // 実際に塗ったマスも初期配置も同じ濃さにして、見た目で区別が付かないようにする。
        const style = {
            ...base,
            weight: TILE_STROKE_WEIGHT,
            opacity: TILE_STROKE_OPACITY,
            fillOpacity: team === 'white' || team === 'black' ? TILE_FILL_OPACITY : base.fillOpacity,
            interactive: false
        };

        // 自分の足跡だけは、自分の端末で細くはっきりした枠を付ける（他人の画面には出ない）
        if (options.ownFootprint && (team === 'white' || team === 'black')) {
            style.color = FOOTPRINT_STROKE_COLOR;
            style.weight = FOOTPRINT_STROKE_WEIGHT;
            style.opacity = FOOTPRINT_STROKE_OPACITY;
        }

        return style;
    }

    /**
     * Redraw all rendered tiles based on current skin
     */
    redrawTiles() {
        for (const [meshId, rectangle] of this.renderedMeshes.entries()) {
            const parts = meshId.split('_');
            if (parts.length !== 3) continue;
            const latIdx = parseInt(parts[1], 10);
            const lngIdx = parseInt(parts[2], 10);
            rectangle.setStyle(this.getTileStyle(this.resolveTileTeam(meshId, latIdx, lngIdx), {
                ownFootprint: this.isOwnFootprint(meshId)
            }));
        }
    }

    /**
     * 全陣地を白紙に戻す（デバッグ専用）
     * キャッシュ・描画・保存データ（localStorage）をまとめてクリアする。
     */
    clearAllTiles() {
        const cleared = this.claimedTilesCache.size;
        this.claimedTilesCache.clear();
        this.footprintIds = [];
        this.footprintSet = new Set();
        this.saveFootprint();
        for (const rectangle of this.renderedMeshes.values()) {
            try {
                rectangle.setStyle(this.getTileStyle(null));
            } catch (e) { /* 描画済みレイヤーの後始末失敗は無視 */ }
        }
        this.saveTilesToStorage();
        console.log(`[Debug] Cleared ${cleared} local tiles -> blank board.`);
        return cleared;
    }

    /**
     * Render tiles in view.
     * Render claimed tiles across all zoom levels like Nazca lines.
     */
    updateGrids() {
        const bounds = this.map.getBounds();
        const currentZoom = this.map.getZoom();

        const south = bounds.getSouth();
        const north = bounds.getNorth();
        const west = bounds.getWest();
        const east = bounds.getEast();

        const minLatIdx = Math.floor(south / this.LAT_GRID);
        const maxLatIdx = Math.floor(north / this.LAT_GRID);
        const minLngIdx = Math.floor(west / this.LNG_GRID);
        const maxLngIdx = Math.floor(east / this.LNG_GRID);

        const currentVisibleMeshes = new Set();
        const maxRender = (typeof CONFIG !== 'undefined' && CONFIG.MAX_TILES_PER_RENDER) ? CONFIG.MAX_TILES_PER_RENDER : 1200;
        const renderMinZoom = (typeof CONFIG !== 'undefined' && CONFIG.TILE_RENDER_MIN_ZOOM) ? CONFIG.TILE_RENDER_MIN_ZOOM : 5;
        let renderedCount = 0;

        // 1. Render all claimed tiles (even if zoomed out)
        if (currentZoom >= renderMinZoom) {
            for (const [meshId] of this.claimedTilesCache.entries()) {
                if (renderedCount >= maxRender) break; // 広域時の描画負荷を上限で抑える
                const parts = meshId.split('_');
                if (parts.length === 3) {
                    const latIdx = parseInt(parts[1], 10);
                    const lngIdx = parseInt(parts[2], 10);

                    if (latIdx >= minLatIdx - 1 && latIdx <= maxLatIdx + 1 &&
                        lngIdx >= minLngIdx - 1 && lngIdx <= maxLngIdx + 1) {

                        currentVisibleMeshes.add(meshId);
                        this.renderSingleTile(meshId, latIdx, lngIdx);
                        renderedCount++;
                    }
                }
            }
        }

        // 2. 近距離表示では、未登録マスも「初期配置」の色で並べる（zoom >= 16）
        if (currentZoom >= 16) {
            for (let latIdx = minLatIdx; latIdx <= maxLatIdx; latIdx++) {
                for (let lngIdx = minLngIdx; lngIdx <= maxLngIdx; lngIdx++) {
                    if (renderedCount >= maxRender) break;
                    const meshId = this.getMeshId(latIdx, lngIdx);
                    currentVisibleMeshes.add(meshId);
                    if (!this.renderedMeshes.has(meshId)) {
                        this.renderSingleTile(meshId, latIdx, lngIdx);
                        renderedCount++;
                    }
                }
            }
        }

        // 3. Remove meshes that moved out of viewport
        for (const [meshId, rectangle] of this.renderedMeshes.entries()) {
            if (!currentVisibleMeshes.has(meshId)) {
                this.gridLayerGroup.removeLayer(rectangle);
                this.renderedMeshes.delete(meshId);
            }
        }
    }

    /**
     * 1マス描く。色は resolveTileTeam が決める（初期配置 / 実績 / 非表示ピン）。
     */
    renderSingleTile(meshId, latIdx, lngIdx) {
        if (latIdx === undefined || lngIdx === undefined) {
            const parts = meshId.split('_');
            latIdx = parseInt(parts[1], 10);
            lngIdx = parseInt(parts[2], 10);
        }

        const style = this.getTileStyle(this.resolveTileTeam(meshId, latIdx, lngIdx), {
            ownFootprint: this.isOwnFootprint(meshId)
        });

        if (this.renderedMeshes.has(meshId)) {
            const rect = this.renderedMeshes.get(meshId);
            rect.setStyle(style);
            return rect;
        }

        const bounds = this.getMeshBounds(latIdx, lngIdx);
        const options = this.canvasRenderer ? { ...style, renderer: this.canvasRenderer } : style;
        const rect = L.rectangle(bounds, options);
        rect.addTo(this.gridLayerGroup);
        this.renderedMeshes.set(meshId, rect);
        return rect;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        GridManager,
        tileHash,
        deterministicInitialTeam,
        isoWeekIdJst,
        TILE_FILL_OPACITY,
        FOOTPRINT_STROKE_COLOR,
        FOOTPRINT_STORAGE_KEY
    };
}
