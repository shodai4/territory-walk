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
 *
 * v1.1 ズーム別の描画（居場所の手がかりを残さない3段階）:
 *   - zoom >= 16（近距離）: 100mマス。初期配置＋実績＋自分の足跡枠線。
 *   - 11 <= zoom < 16（中〜広域）: 100mマスは描かず、10×10マス（約1km四方）のブロックに集計して薄く塗る。
 *     ブロック内の色は多数決なので、細かな歩行経路は分からない。
 *   - zoom < 11（広域）: マスもブロックも一切描かない。
 *   スコア（勝敗）は従来どおり claimedTilesCache だけで集計し、描画とは無関係。
 *
 * v1.2 ブロック表示を県レベル（zoom 11）まで拡張。
 *   375×812 の画面あたりブロック数は約1,400なので、描画上限を
 *   ブロック用に BLOCK_RENDER_MAX_COUNT で別に持つ。
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

/** 1kmブロック = 10×10 の 100mマス */
const BLOCK_TILES = 10;
/** 100mマス（近距離）を描く下限ズーム */
const TILE_DETAIL_MIN_ZOOM = 16;
/** 1kmブロック（中〜広域）を描く下限ズーム。これ未満は何も描かない */
const BLOCK_RENDER_MIN_ZOOM = 11;
/** 画面に描く1kmブロックの上限（375×812 / zoom 11 で約1,400枚。全部埋まる上限） */
const BLOCK_RENDER_MAX_COUNT = 2000;
/**
 * 100mマスを取得する下限ズーム。
 * ブロック表示は zoom 11 からだが、1マス単位のDB取得は13から（画面全体が15kmを超えるため）。
 */
const REMOTE_FETCH_MIN_ZOOM = 13;
/**
 * 週IDの再計算間隔（ms）。
 * getCurrentWeekId() は toLocaleString(Asia/Tokyo) を使うため1回が重く、
 * 県レベル（zoom 11）の1,400ブロック描画で数千回呼ぶと数十msかかる。
 * 週は月曜0時（JST）にしか変わらないので、数秒のキャッシュで十分。
 */
const WEEK_ID_CACHE_MS = 2000;
/**
 * 1kmブロックの描画スタイル。
 * 地図の文字・道路が読めるように薄く塗り、枠線はごく薄くする（＝細かな経路を見せない）。
 */
const BLOCK_FILL_OPACITY = 0.24;
const BLOCK_STROKE_OPACITY = 0.08;
const BLOCK_STROKE_WEIGHT = 0.6;

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

/**
 * 1kmブロックの同数（引き分け）を決める決定論的な色。
 * マス単位のハッシュとは別の塩を混ぜて、ブロックの色が中のマスの並びと相関しないようにする。
 */
function deterministicBlockTeam(weekId, latBlock, lngBlock) {
    return (tileHash(`${weekId}#block`, latBlock, lngBlock) & 1) === 1 ? 'white' : 'black';
}

/**
 * ズームしきい値。CONFIG があればそちらを優先（アプリ側で1か所にまとめる）。
 * テストや単体利用では CONFIG が無いので定数の既定値を使う。
 */
function zoomThresholds() {
    const cfg = (typeof CONFIG !== 'undefined' && CONFIG) ? CONFIG : {};
    const detailMin = Number.isFinite(cfg.TILE_DETAIL_MIN_ZOOM) ? cfg.TILE_DETAIL_MIN_ZOOM : TILE_DETAIL_MIN_ZOOM;
    const blockMin = Number.isFinite(cfg.TILE_RENDER_MIN_ZOOM) ? cfg.TILE_RENDER_MIN_ZOOM : BLOCK_RENDER_MIN_ZOOM;
    return { detailMin, blockMin };
}

/**
 * 現在のズームの表示モード。
 *   'tiles'  : 100mマス（zoom >= 16）
 *   'blocks' : 1kmブロック（11 <= zoom < 16）
 *   'none'   : 何も描かない（zoom < 11）
 */
function displayModeForZoom(zoom) {
    const { detailMin, blockMin } = zoomThresholds();
    const z = Number(zoom);
    if (!Number.isFinite(z)) return 'none';
    if (z >= detailMin) return 'tiles';
    if (z >= blockMin) return 'blocks';
    return 'none';
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
        this.renderedBlocks = new Map();     // blockId -> L.Rectangle layer（中距離表示）
        // ブロックの色（100マスの多数決）のキャッシュ。
        //   県レベル（zoom 11）は画面に約1,400ブロック＝約14万マスの集計が必要で、
        //   パンのたびに数え直すと数十msかかる。ブロック単位で覚えておき、
        //   陣地・非表示ピン・週が変わったときにその分だけ捨てる。
        this.blockTeamCache = new Map();     // `${weekId}|${latBlock}_${lngBlock}` -> 'white' | 'black'

        // 自分の足跡（今週踏んだマス）。端末内のみ・サーバーへは送らない
        this.footprintWeek = null;
        this.footprintIds = [];
        this.footprintSet = new Set();

        // 初期配置の色を決める週（週明けに更新される）
        this.weekId = null;

        // Use Canvas renderer for low memory footprint and high 60fps performance
        // （地図が preferCanvas: true なら同じキャンバスを使い回し、キャンバスを二重に持たない）
        this.canvasRenderer = (typeof L !== 'undefined' && L.canvas) ? this.resolveCanvasRenderer() : null;
        this.gridLayerGroup = L.layerGroup().addTo(this.map);

        this.checkWeekReset();
        this.loadTilesFromStorage();
        this.loadFootprint();
        this.initEventListeners();
    }

    /**
     * マス描画用の Canvas レンダラ。
     * L.map が preferCanvas: true なら地図の共通レンダラを返し、画面サイズ分の
     * キャンバスをもう1枚作らない（グリッドもプライバシー円も同じキャンバスに描く）。
     */
    resolveCanvasRenderer() {
        try {
            const map = this.map;
            if (map && map.options && map.options.preferCanvas === true
                && typeof map.getRenderer === 'function') {
                const shared = map.getRenderer({ options: {} });
                if (shared) return shared;
            }
        } catch (e) { /* 共通レンダラが取れない環境では自前で作る */ }
        return L.canvas({ padding: 0.5 });
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

    /* ---------------- 1kmブロック（中距離表示） ---------------- */

    /** マス座標 → ブロック座標（10×10マスで1ブロック ≒ 1km 四方） */
    getBlockIndices(latIdx, lngIdx) {
        return {
            latBlock: Math.floor(latIdx / BLOCK_TILES),
            lngBlock: Math.floor(lngIdx / BLOCK_TILES)
        };
    }

    getBlockId(latBlock, lngBlock) {
        return `block_${latBlock}_${lngBlock}`;
    }

    /** ブロックの外枠（南西・北東の座標） */
    getBlockBounds(latBlock, lngBlock) {
        const south = latBlock * BLOCK_TILES * this.LAT_GRID;
        const north = south + BLOCK_TILES * this.LAT_GRID;
        const west = lngBlock * BLOCK_TILES * this.LNG_GRID;
        const east = west + BLOCK_TILES * this.LNG_GRID;
        return [[south, west], [north, east]];
    }

    /**
     * ブロック内の100マスを数える。
     * 非表示ピンの中のマスは「中立」として数えない（区域の存在を色に滲ませない）。
     * 県レベル（zoom 11）は画面あたり約1,400ブロック＝約14万マスを数えるので、
     * 1マスあたりの処理を最小限にする（文字列生成とメソッド呼び出しを減らす）。
     */
    tallyBlock(latBlock, lngBlock) {
        const weekId = this.getWeekId();
        const latBase = latBlock * BLOCK_TILES;
        const lngBase = lngBlock * BLOCK_TILES;
        const cache = this.claimedTilesCache;
        // 非表示ピンが1件も無い（大多数の端末）なら、マスごとの判定自体を省く
        const hasPrivacy = !!(this.app && this.app.privacyZones
            && typeof this.app.privacyZones.containsMesh === 'function');
        let white = 0;
        let black = 0;
        let masked = 0;

        for (let dLat = 0; dLat < BLOCK_TILES; dLat += 1) {
            const latIdx = latBase + dLat;
            for (let dLng = 0; dLng < BLOCK_TILES; dLng += 1) {
                const lngIdx = lngBase + dLng;
                if (hasPrivacy && this.getPrivacyZone(latIdx, lngIdx)) {
                    masked += 1;
                    continue;
                }
                // 実績があればそれが色、無ければ週と座標で決まる初期配置（resolveTileTeam と同じ規則）
                const claimed = cache.get(`tile_${latIdx}_${lngIdx}`);
                const team = (claimed === 'white' || claimed === 'black')
                    ? claimed
                    : deterministicInitialTeam(weekId, latIdx, lngIdx);
                if (team === 'white') white += 1;
                else black += 1;
            }
        }

        return { white, black, masked, counted: white + black };
    }

    /**
     * ブロックの色。白黒の多い方。同数（と全マス非表示）は week_id とブロック座標のハッシュで決める。
     */
    resolveBlockTeam(latBlock, lngBlock) {
        const { white, black } = this.tallyBlock(latBlock, lngBlock);
        if (white > black) return 'white';
        if (black > white) return 'black';
        return deterministicBlockTeam(this.getWeekId(), latBlock, lngBlock);
    }

    /* ---------------- ブロック色のキャッシュ（県レベルの描画を軽くする） ---------------- */

    /** キャッシュキー。週が変われば別キーになるので古い週の値は使われない */
    blockTeamCacheKey(latBlock, lngBlock) {
        return `${this.getWeekId()}|${latBlock}_${lngBlock}`;
    }

    /** キャッシュ付きの resolveBlockTeam（描画はこちらを使う） */
    resolveBlockTeamCached(latBlock, lngBlock) {
        if (!this.blockTeamCache || typeof this.blockTeamCache.get !== 'function') {
            return this.resolveBlockTeam(latBlock, lngBlock);
        }
        const key = this.blockTeamCacheKey(latBlock, lngBlock);
        const cached = this.blockTeamCache.get(key);
        if (cached === 'white' || cached === 'black') return cached;
        const team = this.resolveBlockTeam(latBlock, lngBlock);
        this.blockTeamCache.set(key, team);
        return team;
    }

    /** 1マスが塗り替わった → そのマスが属するブロックのキャッシュだけを捨てる */
    invalidateBlockTeamAt(latIdx, lngIdx) {
        if (!this.blockTeamCache || typeof this.blockTeamCache.delete !== 'function') return false;
        if (!Number.isFinite(latIdx) || !Number.isFinite(lngIdx)) return false;
        const { latBlock, lngBlock } = this.getBlockIndices(latIdx, lngIdx);
        return this.blockTeamCache.delete(this.blockTeamCacheKey(latBlock, lngBlock));
    }

    /** 広い範囲の陣地が変わった（リモート取り込み・非表示ピン・週リセット） → 全部捨てる */
    clearBlockTeamCache() {
        const size = this.blockTeamCache.size;
        this.blockTeamCache.clear();
        return size;
    }

    /** 現在の週ID（初期配置のハッシュ種）。短時間キャッシュして描画中の再計算を避ける */
    getWeekId() {
        const now = Date.now();
        if (this.weekId && this.weekIdCachedAt && (now - this.weekIdCachedAt) < WEEK_ID_CACHE_MS) {
            return this.weekId;
        }
        if (this.app && this.app.supabaseManager
            && typeof this.app.supabaseManager.getCurrentWeekId === 'function') {
            this.weekId = this.app.supabaseManager.getCurrentWeekId();
        } else if (!this.weekId) {
            this.weekId = isoWeekIdJst();
        }
        this.weekIdCachedAt = now;
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
        // 保存分を読んだので、古いブロック色のキャッシュがあれば捨てる
        this.clearBlockTeamCache();
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
    resolveTileTeam(meshId, latIdx, lngIdx, weekId = null) {
        const week = weekId || this.getWeekId();
        if (this.getPrivacyZone(latIdx, lngIdx)) {
            return deterministicInitialTeam(week, latIdx, lngIdx);
        }
        const claimed = this.claimedTilesCache.get(meshId);
        if (claimed === 'white' || claimed === 'black') return claimed;
        return deterministicInitialTeam(week, latIdx, lngIdx);
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

        // 広域表示（zoom < 13）では取得しない：そのズームではマスを描かず、
        // 大範囲クエリによるDB負荷・描画負荷も防ぐ（zoom 11〜12 は初期配置だけでブロックを描く）。
        const zoom = this.map ? this.map.getZoom() : 0;
        const minZoom = (typeof CONFIG !== 'undefined' && CONFIG && Number.isFinite(CONFIG.REMOTE_FETCH_MIN_ZOOM))
            ? CONFIG.REMOTE_FETCH_MIN_ZOOM
            : REMOTE_FETCH_MIN_ZOOM;
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
                    // リモートで陣地が変わった → ブロック色のキャッシュも捨てる
                    this.clearBlockTeamCache();
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
     * Redraw all rendered tiles / blocks based on current skin
     */
    redrawTiles() {
        // 見た目を作り直すので、ブロック色のキャッシュも捨ててから数え直す
        this.clearBlockTeamCache();
        for (const [meshId, rectangle] of this.renderedMeshes.entries()) {
            const parts = meshId.split('_');
            if (parts.length !== 3) continue;
            const latIdx = parseInt(parts[1], 10);
            const lngIdx = parseInt(parts[2], 10);
            rectangle.setStyle(this.getTileStyle(this.resolveTileTeam(meshId, latIdx, lngIdx), {
                ownFootprint: this.isOwnFootprint(meshId)
            }));
            // 直接 setStyle したので、次の描画で差分判定をやり直す
            rectangle._twStyleKey = null;
        }
        for (const [blockId, rectangle] of this.renderedBlocks.entries()) {
            const parts = blockId.split('_');
            if (parts.length !== 3) continue;
            const latBlock = parseInt(parts[1], 10);
            const lngBlock = parseInt(parts[2], 10);
            rectangle.setStyle(this.getBlockStyle(this.resolveBlockTeam(latBlock, lngBlock)));
            rectangle._twStyleKey = null;
        }
    }

    /**
     * 全陣地を白紙に戻す（デバッグ専用）
     * キャッシュ・描画・保存データ（localStorage）をまとめてクリアする。
     */
    clearAllTiles() {
        const cleared = this.claimedTilesCache.size;
        this.claimedTilesCache.clear();
        this.clearBlockTeamCache();
        this.footprintIds = [];
        this.footprintSet = new Set();
        this.saveFootprint();
        for (const rectangle of this.renderedMeshes.values()) {
            try {
                rectangle.setStyle(this.getTileStyle(null));
            } catch (e) { /* 描画済みレイヤーの後始末失敗は無視 */ }
        }
        for (const rectangle of this.renderedBlocks.values()) {
            try {
                rectangle.setStyle(this.getBlockStyle(null));
            } catch (e) { /* 同上 */ }
        }
        this.saveTilesToStorage();
        console.log(`[Debug] Cleared ${cleared} local tiles -> blank board.`);
        return cleared;
    }

    /**
     * 画面内を描く。ズームで3段階に切り替える（updateGrids の唯一の入口）。
     *   zoom >= 16 : 100mマス
     *   11 <= zoom < 16 : 1kmブロック（県レベルまで）
     *   zoom < 11 : 何も描かない（画面上のマス・ブロックをすべて消す）
     */
    updateGrids() {
        const bounds = this.map.getBounds();
        const currentZoom = this.map.getZoom();
        const mode = displayModeForZoom(currentZoom);

        if (mode === 'tiles') {
            this.clearRenderedBlocks();
            this.updateTileGrids(bounds);
            return;
        }
        if (mode === 'blocks') {
            this.clearRenderedTiles();
            this.updateBlockGrids(bounds);
            return;
        }
        // 広域（zoom < 11）: 過疎地で「誰かが歩いた場所」が浮き上がらないよう、何も描かない
        this.clearRenderedTiles();
        this.clearRenderedBlocks();
    }

    /** 近距離（zoom >= 16）: 実績マス＋初期配置の100mマス */
    updateTileGrids(bounds) {
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
        let renderedCount = 0;

        // 1. 実績マスを先に描く（描画上限に達しても、実際に塗られたマスを優先して残す）
        for (const [meshId] of this.claimedTilesCache.entries()) {
            if (renderedCount >= maxRender) break;
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

        // 2. 未登録マスも「初期配置」の色で並べる（初期配置・実績・足跡を同じ濃さで区別なく見せる）
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

        // 3. 画面外に出たマスを消す
        for (const [meshId, rectangle] of this.renderedMeshes.entries()) {
            if (!currentVisibleMeshes.has(meshId)) {
                this.gridLayerGroup.removeLayer(rectangle);
                this.renderedMeshes.delete(meshId);
            }
        }
    }

    /** 中〜広域（11 <= zoom < 16）: 10×10マスをまとめた1kmブロック */
    updateBlockGrids(bounds) {
        const minLatIdx = Math.floor(bounds.getSouth() / this.LAT_GRID);
        const maxLatIdx = Math.floor(bounds.getNorth() / this.LAT_GRID);
        const minLngIdx = Math.floor(bounds.getWest() / this.LNG_GRID);
        const maxLngIdx = Math.floor(bounds.getEast() / this.LNG_GRID);

        const minLatBlock = Math.floor(minLatIdx / BLOCK_TILES);
        const maxLatBlock = Math.floor(maxLatIdx / BLOCK_TILES);
        const minLngBlock = Math.floor(minLngIdx / BLOCK_TILES);
        const maxLngBlock = Math.floor(maxLngIdx / BLOCK_TILES);

        // ブロックは県レベル（zoom 11）で約1,400枚になるので、マス用の上限とは別に持つ
        const maxRender = (typeof CONFIG !== 'undefined' && CONFIG.BLOCK_RENDER_MAX_COUNT)
            ? CONFIG.BLOCK_RENDER_MAX_COUNT
            : (typeof CONFIG !== 'undefined' && CONFIG.MAX_TILES_PER_RENDER ? Math.max(CONFIG.MAX_TILES_PER_RENDER, BLOCK_RENDER_MAX_COUNT) : BLOCK_RENDER_MAX_COUNT);
        const currentVisibleBlocks = new Set();
        let renderedCount = 0;

        for (let latBlock = minLatBlock; latBlock <= maxLatBlock; latBlock++) {
            for (let lngBlock = minLngBlock; lngBlock <= maxLngBlock; lngBlock++) {
                if (renderedCount >= maxRender) break;
                const blockId = this.getBlockId(latBlock, lngBlock);
                currentVisibleBlocks.add(blockId);
                // 既に描いてあるブロックも、中の塗りが変わっていれば色を更新する
                this.renderSingleBlock(blockId, latBlock, lngBlock);
                renderedCount++;
            }
        }

        // 画面外に出たブロックを消す
        for (const [blockId, rectangle] of this.renderedBlocks.entries()) {
            if (!currentVisibleBlocks.has(blockId)) {
                this.gridLayerGroup.removeLayer(rectangle);
                this.renderedBlocks.delete(blockId);
            }
        }
    }

    /** 100mマスのレイヤーをすべて消す（モード切替・広域表示用） */
    clearRenderedTiles() {
        for (const rectangle of this.renderedMeshes.values()) {
            this.gridLayerGroup.removeLayer(rectangle);
        }
        this.renderedMeshes.clear();
    }

    /** 1kmブロックのレイヤーをすべて消す（モード切替・広域表示用） */
    clearRenderedBlocks() {
        for (const rectangle of this.renderedBlocks.values()) {
            this.gridLayerGroup.removeLayer(rectangle);
        }
        this.renderedBlocks.clear();
    }

    /**
     * 今のズームに合った形で1マス分を描き直す（塗った直後に呼ばれる）。
     *   近距離 = そのマス、中距離 = そのマスが属するブロック、広域 = 何もしない
     */
    renderTileForCurrentZoom(meshId, latIdx, lngIdx) {
        const zoom = (this.map && typeof this.map.getZoom === 'function') ? this.map.getZoom() : null;
        const mode = (zoom === null) ? 'tiles' : displayModeForZoom(zoom);

        if (mode === 'tiles') return this.renderSingleTile(meshId, latIdx, lngIdx);
        if (mode === 'blocks') {
            const { latBlock, lngBlock } = this.getBlockIndices(latIdx, lngIdx);
            return this.renderSingleBlock(this.getBlockId(latBlock, lngBlock), latBlock, lngBlock);
        }
        return null;
    }

    /** 現在のスキン（データ属性）。見た目の差分判定に使う */
    currentSkin() {
        try {
            if (typeof document !== 'undefined' && document.body && document.body.dataset) {
                return document.body.dataset.skin || 'default';
            }
        } catch (e) { /* ignore */ }
        return 'default';
    }

    /**
     * 1マス描く。色は resolveTileTeam が決める（初期配置 / 実績 / 非表示ピン）。
     * 見た目が前回と同じなら setStyle しない（Canvas の描き直しを減らす）。
     */
    renderSingleTile(meshId, latIdx, lngIdx) {
        if (latIdx === undefined || lngIdx === undefined) {
            const parts = meshId.split('_');
            latIdx = parseInt(parts[1], 10);
            lngIdx = parseInt(parts[2], 10);
        }

        const team = this.resolveTileTeam(meshId, latIdx, lngIdx);
        const ownFootprint = this.isOwnFootprint(meshId);
        const styleKey = `${team}|${ownFootprint ? 1 : 0}|${this.currentSkin()}`;

        if (this.renderedMeshes.has(meshId)) {
            const rect = this.renderedMeshes.get(meshId);
            if (rect._twStyleKey === styleKey) return rect;
            rect.setStyle(this.getTileStyle(team, { ownFootprint }));
            rect._twStyleKey = styleKey;
            return rect;
        }

        const style = this.getTileStyle(team, { ownFootprint });
        const bounds = this.getMeshBounds(latIdx, lngIdx);
        const options = this.canvasRenderer ? { ...style, renderer: this.canvasRenderer } : style;
        const rect = L.rectangle(bounds, options);
        rect._twStyleKey = styleKey;
        rect.addTo(this.gridLayerGroup);
        this.renderedMeshes.set(meshId, rect);
        return rect;
    }

    /**
     * ブロックの描画スタイル。スキンの色はそのままに、塗りを薄く・枠線をごく薄くする。
     * 100mマスの細かい経路が見えないようにするための濃さ。
     */
    getBlockStyle(team) {
        const base = this.getTileStyle(team);
        const claimed = team === 'white' || team === 'black';
        return {
            ...base,
            weight: BLOCK_STROKE_WEIGHT,
            opacity: BLOCK_STROKE_OPACITY,
            fillOpacity: claimed ? BLOCK_FILL_OPACITY : base.fillOpacity,
            interactive: false
        };
    }

    /**
     * 1ブロック（約1km四方）描く。色は resolveBlockTeamCached（ブロック内100マスの多数決）。
     * 見た目が前回と同じなら setStyle しない（1,400枚の再描画を防ぐ）。
     */
    renderSingleBlock(blockId, latBlock, lngBlock) {
        const team = this.resolveBlockTeamCached(latBlock, lngBlock);
        const styleKey = `${team}|${this.currentSkin()}`;

        if (this.renderedBlocks.has(blockId)) {
            const rect = this.renderedBlocks.get(blockId);
            if (rect._twStyleKey === styleKey) return rect;
            rect.setStyle(this.getBlockStyle(team));
            rect._twStyleKey = styleKey;
            return rect;
        }

        const style = this.getBlockStyle(team);
        const bounds = this.getBlockBounds(latBlock, lngBlock);
        const options = this.canvasRenderer ? { ...style, renderer: this.canvasRenderer } : style;
        const rect = L.rectangle(bounds, options);
        rect._twStyleKey = styleKey;
        rect.addTo(this.gridLayerGroup);
        this.renderedBlocks.set(blockId, rect);
        return rect;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        GridManager,
        tileHash,
        deterministicInitialTeam,
        deterministicBlockTeam,
        isoWeekIdJst,
        displayModeForZoom,
        zoomThresholds,
        TILE_FILL_OPACITY,
        BLOCK_TILES,
        BLOCK_FILL_OPACITY,
        TILE_DETAIL_MIN_ZOOM,
        BLOCK_RENDER_MIN_ZOOM,
        BLOCK_RENDER_MAX_COUNT,
        REMOTE_FETCH_MIN_ZOOM,
        FOOTPRINT_STROKE_COLOR,
        FOOTPRINT_STORAGE_KEY
    };
}
