/**
 * TERRITORY WALK - grid.js
 * 100m Quad Mesh Calculation, Tile State Management, Dynamic Styling & Leaflet Grid Layer
 */

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

        // Use Canvas renderer for low memory footprint and high 60fps performance
        this.canvasRenderer = (typeof L !== 'undefined' && L.canvas) ? L.canvas({ padding: 0.5 }) : null;
        this.gridLayerGroup = L.layerGroup().addTo(this.map);

        this.checkWeekReset();
        this.loadTilesFromStorage();
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

    getMeshId(latIdx, lngIdx) {
        return `tile_${latIdx}_${lngIdx}`;
    }

    getMeshIdFromLatLng(lat, lng) {
        const { latIdx, lngIdx } = this.getMeshIndices(lat, lng);
        return { meshId: this.getMeshId(latIdx, lngIdx), latIdx, lngIdx };
    }

    checkWeekReset() {
        if (!this.app || !this.app.supabaseManager) return;
        const currentWeek = this.app.supabaseManager.getCurrentWeekId();
        const savedWeek = localStorage.getItem('territory_current_week');

        if (savedWeek && savedWeek !== currentWeek) {
            console.log(`Weekly reset detected: ${savedWeek} -> ${currentWeek}`);
            localStorage.removeItem('territory_claimed_tiles');
            this.claimedTilesCache.clear();
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
                        this.claimedTilesCache.set(id, team);
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
     * Get style definition for tile based on team and current active skin
     */
    getTileStyle(team) {
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
        
        return {
            ...base,
            opacity: 0.9,
            interactive: false
        };
    }

    /**
     * Redraw all rendered tiles based on current skin
     */
    redrawTiles() {
        for (const [meshId, rectangle] of this.renderedMeshes.entries()) {
            const team = this.claimedTilesCache.get(meshId);
            rectangle.setStyle(this.getTileStyle(team));
        }
    }

    /**
     * 全陣地を白紙に戻す（デバッグ専用）
     * キャッシュ・描画・保存データ（localStorage）をまとめてクリアする。
     */
    clearAllTiles() {
        const cleared = this.claimedTilesCache.size;
        this.claimedTilesCache.clear();
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
            for (const [meshId, team] of this.claimedTilesCache.entries()) {
                if (renderedCount >= maxRender) break; // 広域時の描画負荷を上限で抑える
                const parts = meshId.split('_');
                if (parts.length === 3) {
                    const latIdx = parseInt(parts[1], 10);
                    const lngIdx = parseInt(parts[2], 10);

                    if (latIdx >= minLatIdx - 1 && latIdx <= maxLatIdx + 1 &&
                        lngIdx >= minLngIdx - 1 && lngIdx <= maxLngIdx + 1) {

                        currentVisibleMeshes.add(meshId);
                        this.renderSingleTile(meshId, latIdx, lngIdx, team);
                        renderedCount++;
                    }
                }
            }
        }

        // 2. Render unclaimed empty grid only when zoomed in close (zoom >= 16)
        if (currentZoom >= 16) {
            for (let latIdx = minLatIdx; latIdx <= maxLatIdx; latIdx++) {
                for (let lngIdx = minLngIdx; lngIdx <= maxLngIdx; lngIdx++) {
                    const meshId = this.getMeshId(latIdx, lngIdx);
                    currentVisibleMeshes.add(meshId);
                    if (!this.renderedMeshes.has(meshId)) {
                        this.renderSingleTile(meshId, latIdx, lngIdx, this.claimedTilesCache.get(meshId));
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

    renderSingleTile(meshId, latIdx, lngIdx, team) {
        if (this.renderedMeshes.has(meshId)) {
            const rect = this.renderedMeshes.get(meshId);
            rect.setStyle(this.getTileStyle(team));
            return;
        }

        const bounds = this.getMeshBounds(latIdx, lngIdx);
        const options = this.canvasRenderer ? { ...this.getTileStyle(team), renderer: this.canvasRenderer } : this.getTileStyle(team);
        const rect = L.rectangle(bounds, options);
        rect.addTo(this.gridLayerGroup);
        this.renderedMeshes.set(meshId, rect);
    }
}
