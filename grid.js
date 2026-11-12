/**
 * TERRITORY WALK - grid.js
 * 100m Mesh Grid Calculation & Layer Render Module
 */

class GridManager {
    constructor(mapInstance, appInstance) {
        this.map = mapInstance;
        this.app = appInstance;
        this.gridLayerGroup = L.layerGroup().addTo(this.map);
        this.renderedMeshes = new Map();
        this.claimedTilesCache = new Map();

        this.LAT_GRID = 0.0009; // 約100m四方の緯度グリッド
        this.MIN_ZOOM_FOR_GRID = 14;

        this.initEventListeners();
        this.updateGrids();
    }

    getMeshIndices(lat, lng) {
        const latIdx = Math.floor(lat / this.LAT_GRID);
        const lngGrid = this.LAT_GRID / Math.cos(lat * Math.PI / 180);
        const lngIdx = Math.floor(lng / lngGrid);
        return { latIdx, lngIdx };
    }

    getMeshBounds(latIdx, lngIdx) {
        const centerLat = (latIdx + 0.5) * this.LAT_GRID;
        const lngGrid = this.LAT_GRID / Math.cos(centerLat * Math.PI / 180);

        const south = latIdx * this.LAT_GRID;
        const north = (latIdx + 1) * this.LAT_GRID;
        const west = lngIdx * lngGrid;
        const east = (lngIdx + 1) * lngGrid;

        return L.latLngBounds([south, west], [north, east]);
    }

    getMeshId(latIdx, lngIdx) {
        return `${latIdx}_${lngIdx}`;
    }

    getMeshIdFromLatLng(lat, lng) {
        const { latIdx, lngIdx } = this.getMeshIndices(lat, lng);
        return { meshId: this.getMeshId(latIdx, lngIdx), latIdx, lngIdx };
    }

    initEventListeners() {
        let throttleTimer = null;
        const onMapChange = () => {
            if (throttleTimer) return;
            throttleTimer = setTimeout(() => {
                this.updateGrids();
                throttleTimer = null;
            }, 150);
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

            if (updated && this.app.updateScoreUI) {
                this.app.updateScoreUI();
            }
        } catch (e) {
            console.warn('Tile sync failed or running offline:', e);
        }
    }

    async updateGrids() {
        const currentZoom = this.map.getZoom();

        if (currentZoom < this.MIN_ZOOM_FOR_GRID) {
            if (this.renderedMeshes.size > 0) {
                this.gridLayerGroup.clearLayers();
                this.renderedMeshes.clear();
            }
            return;
        }

        await this.fetchAndSyncTiles();

        const bounds = this.map.getBounds();
        const north = bounds.getNorth();
        const south = bounds.getSouth();
        const west = bounds.getWest();
        const east = bounds.getEast();

        const swIndices = this.getMeshIndices(south, west);
        const neIndices = this.getMeshIndices(north, east);

        const minLatIdx = Math.min(swIndices.latIdx, neIndices.latIdx) - 1;
        const maxLatIdx = Math.max(swIndices.latIdx, neIndices.latIdx) + 1;
        const minLngIdx = Math.min(swIndices.lngIdx, neIndices.lngIdx) - 1;
        const maxLngIdx = Math.max(swIndices.lngIdx, neIndices.lngIdx) + 1;

        const newVisibleMeshIds = new Set();

        for (let latIdx = minLatIdx; latIdx <= maxLatIdx; latIdx++) {
            for (let lngIdx = minLngIdx; lngIdx <= maxLngIdx; lngIdx++) {
                const meshId = this.getMeshId(latIdx, lngIdx);
                newVisibleMeshIds.add(meshId);

                const team = this.claimedTilesCache.get(meshId);
                const style = this.getTileStyle(team);

                if (this.renderedMeshes.has(meshId)) {
                    const rectangle = this.renderedMeshes.get(meshId);
                    rectangle.setStyle(style);
                } else {
                    const meshBounds = this.getMeshBounds(latIdx, lngIdx);
                    const rectangle = L.rectangle(meshBounds, style);
                    this.gridLayerGroup.addLayer(rectangle);
                    this.renderedMeshes.set(meshId, rectangle);
                }
            }
        }

        for (const [meshId, rectangle] of this.renderedMeshes.entries()) {
            if (!newVisibleMeshIds.has(meshId)) {
                this.gridLayerGroup.removeLayer(rectangle);
                this.renderedMeshes.delete(meshId);
            }
        }
    }

    getTileStyle(team) {
        if (team === 'white') {
            return {
                color: '#ffffff',
                weight: 1.5,
                opacity: 0.95,
                fillColor: '#ffffff',
                fillOpacity: 0.7,
                interactive: false
            };
        } else if (team === 'black') {
            return {
                color: '#52525b', // Zinc-600 の明確な境界線（ダーク背景・街路樹マップ両方でくっきり視認）
                weight: 1.5,
                opacity: 0.95,
                fillColor: '#09090b',
                fillOpacity: 0.85,
                interactive: false
            };
        } else {
            return {
                color: '#3f3f46',
                weight: 1,
                opacity: 0.25,
                fillColor: '#ffffff',
                fillOpacity: 0.02,
                interactive: false
            };
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

        if (this.renderedMeshes.has(meshId)) {
            this.renderedMeshes.get(meshId).setStyle(this.getTileStyle(currentTeam));
        }

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
