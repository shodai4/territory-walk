/**
 * TERRITORY WALK - privacy.js
 * 非表示ピン（プライバシーゾーン）: 自宅・職場などの半径を「塗らない・送らない・数えない」区域にする。
 *
 * 方針（v1.1 A案）
 *   1. 登録できるのは最大 5 件（無料のまま）。半径は 300m / 500m の2択。
 *   2. 登録時に中心を半径の 20〜30% の範囲でランダムにずらし、ずらした後の座標だけを持つ。
 *      → 端末内（localStorage）のみ。Supabase 等のサーバーへは一切送らない。
 *   3. 区域の中では自分の画面でもマスを塗らず、送信もスコア加算もしない。
 *      （マスの見た目は「初期配置」のまま＝区域の位置が他人に分からない）
 *
 * 実行: npm test （node --test tests/）
 */

/* ------------------------------------------------------------------ *
 * 定数
 * ------------------------------------------------------------------ */
const PRIVACY_STORAGE_KEY = 'tw_privacy_zones';
const PRIVACY_RADIUS_STORAGE_KEY = 'tw_privacy_radius';
const PRIVACY_MAX_ZONES = 5;
const PRIVACY_RADIUS_OPTIONS = [300, 500];
const PRIVACY_DEFAULT_RADIUS = 300;
const PRIVACY_JITTER_RATIO_MIN = 0.2;
const PRIVACY_JITTER_RATIO_MAX = 0.3;
const PRIVACY_DEFAULT_LABEL = '自宅';
const PRIVACY_LABEL_MAX_LENGTH = 12;
const PRIVACY_LABEL_PRESETS = ['自宅', '職場', '学校', '実家'];

/* ------------------------------------------------------------------ *
 * 純粋関数（テスト対象）
 * ------------------------------------------------------------------ */

/** 2点間の距離（m）。地球を半径 6371000m の球として扱う。 */
function privacyDistanceMeters(lat1, lng1, lat2, lng2) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const R = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** ある点から方位 bearingRad・距離 meters だけ進んだ座標（球面近似）。 */
function privacyDestinationPoint(lat, lng, meters, bearingRad) {
    const R = 6371000;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const toDeg = (rad) => (rad * 180) / Math.PI;
    const φ1 = toRad(lat);
    const λ1 = toRad(lng);
    const δ = meters / R;
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(bearingRad));
    const λ2 = λ1 + Math.atan2(
        Math.sin(bearingRad) * Math.sin(δ) * Math.cos(φ1),
        Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
    );
    // 経度は -180〜180 に正規化
    let lng2 = toDeg(λ2);
    lng2 = ((lng2 + 540) % 360) - 180;
    return { lat: toDeg(φ2), lng: lng2 };
}

/**
 * 登録する中心座標をランダムにずらす。
 * ずらす距離は半径の 20〜30%（＝真の中心から半径の 20〜30% 離れた場所が保存される）。
 * ずらした後の座標だけを保存するので、端末を覗かれても自宅の中心は分からない。
 */
function privacyJitterCenter(lat, lng, radiusMeters, random = Math.random) {
    const radius = Number(radiusMeters);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius) || radius <= 0) {
        return { lat, lng };
    }
    const ratio = PRIVACY_JITTER_RATIO_MIN
        + random() * (PRIVACY_JITTER_RATIO_MAX - PRIVACY_JITTER_RATIO_MIN);
    const bearing = random() * Math.PI * 2;
    return privacyDestinationPoint(lat, lng, radius * ratio, bearing);
}

/** 半径を 300m / 500m のどちらかに正規化する（それ以外は既定 300m）。 */
function privacyNormalizeRadius(radius) {
    const n = Number(radius);
    return PRIVACY_RADIUS_OPTIONS.includes(n) ? n : PRIVACY_DEFAULT_RADIUS;
}

/** ラベルを整える（空・長すぎ・制御文字を落とす）。 */
function privacyNormalizeLabel(label) {
    const text = String(label === undefined || label === null ? '' : label)
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim();
    if (!text) return PRIVACY_DEFAULT_LABEL;
    return text.length > PRIVACY_LABEL_MAX_LENGTH ? text.slice(0, PRIVACY_LABEL_MAX_LENGTH) : text;
}

/** localStorage から読んだ値（何でも来る）を、使えるゾーン配列に正規化する。 */
function privacyNormalizeZones(raw) {
    if (!Array.isArray(raw)) return [];
    const zones = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const lat = Number(item.lat);
        const lng = Number(item.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
        zones.push({
            id: String(item.id || `z_${zones.length + 1}`),
            label: privacyNormalizeLabel(item.label),
            lat,
            lng,
            radius: privacyNormalizeRadius(item.radius),
            createdAt: Number(item.createdAt) || 0
        });
        if (zones.length >= PRIVACY_MAX_ZONES) break;
    }
    return zones;
}

/** ある点が区域の中か（区域の縁も含める）。 */
function privacyZoneContains(zone, lat, lng) {
    if (!zone) return false;
    const radius = Number(zone.radius || 0);
    if (radius <= 0) return false;
    // 緯度だけで先に大きく外側を弾く（描画ループで毎マス判定するため）
    if (Math.abs(lat - zone.lat) * 111320 > radius) return false;
    const distance = privacyDistanceMeters(lat, lng, zone.lat, zone.lng);
    return distance <= radius;
}

/** 区域の配列から、その点を含む最初の区域を返す（無ければ null）。 */
function privacyFindZone(zones, lat, lng) {
    if (!Array.isArray(zones)) return null;
    for (const zone of zones) {
        if (privacyZoneContains(zone, lat, lng)) return zone;
    }
    return null;
}

/**
 * 区域を追加する（純粋関数）。
 * @returns {{ ok: true, zones: Array, zone: Object } | { ok: false, reason: string }}
 */
function privacyAddZone(zones, input = {}, random = Math.random) {
    const current = privacyNormalizeZones(zones);
    if (current.length >= PRIVACY_MAX_ZONES) {
        return { ok: false, reason: 'max-zones' };
    }
    const lat = Number(input.lat);
    const lng = Number(input.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)
        || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return { ok: false, reason: 'invalid-coordinate' };
    }
    const radius = privacyNormalizeRadius(input.radius);
    const center = privacyJitterCenter(lat, lng, radius, random);
    const zone = {
        id: input.id ? String(input.id) : `z_${current.length + 1}_${Math.floor(random() * 1e6).toString(36)}`,
        label: privacyNormalizeLabel(input.label),
        lat: center.lat,
        lng: center.lng,
        radius,
        createdAt: Number(input.createdAt) || 0
    };
    return { ok: true, zones: current.concat([zone]), zone };
}

/** 区域を削除する（純粋関数）。 */
function privacyRemoveZone(zones, id) {
    return privacyNormalizeZones(zones).filter((zone) => zone.id !== String(id));
}

/* ------------------------------------------------------------------ *
 * マネージャ（localStorage + 地図描画 + 設定UI）
 * ------------------------------------------------------------------ */
class PrivacyZoneManager {
    constructor(app) {
        this.app = app || null;
        this.zones = [];
        this.radius = PRIVACY_DEFAULT_RADIUS;
        this.pickMode = false;
        this.pendingCenter = null;
        this.circles = new Map();
        this.layerGroup = null;
        this.load();
    }

    /* ---------------- 保存・読み込み ---------------- */

    storage() {
        try {
            if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
        } catch (e) { /* 参照できない環境ではメモリだけ */ }
        return null;
    }

    load() {
        const storage = this.storage();
        if (!storage) return;
        try {
            const raw = storage.getItem(PRIVACY_STORAGE_KEY);
            this.zones = raw ? privacyNormalizeZones(JSON.parse(raw)) : [];
        } catch (e) {
            this.zones = [];
        }
        try {
            this.radius = privacyNormalizeRadius(storage.getItem(PRIVACY_RADIUS_STORAGE_KEY));
        } catch (e) {
            this.radius = PRIVACY_DEFAULT_RADIUS;
        }
    }

    save() {
        const storage = this.storage();
        if (!storage) return;
        try {
            storage.setItem(PRIVACY_STORAGE_KEY, JSON.stringify(this.zones));
            storage.setItem(PRIVACY_RADIUS_STORAGE_KEY, String(this.radius));
        } catch (e) {
            console.warn('[Privacy] Failed to save zones:', e);
        }
    }

    /* ---------------- 判定 ---------------- */

    getZones() {
        return this.zones.slice();
    }

    canAdd() {
        return this.zones.length < PRIVACY_MAX_ZONES;
    }

    /** その座標は非表示区域の中か（＝塗らない・送らない・数えない） */
    contains(lat, lng) {
        return privacyFindZone(this.zones, lat, lng);
    }

    /** マスの中心座標で判定する（描画・塗りの両方で同じ結果にする） */
    containsMesh(latIdx, lngIdx, grid) {
        if (!this.zones.length || !grid) return null;
        return this.contains(grid.getMeshCenter(latIdx, lngIdx));
    }

    setRadius(radius) {
        this.radius = privacyNormalizeRadius(radius);
        this.save();
        this.renderUI();
    }

    add(input) {
        const result = privacyAddZone(this.zones, { ...input, radius: input && input.radius ? input.radius : this.radius });
        if (!result.ok) return result;
        this.zones = result.zones;
        this.save();
        this.refreshMapLayer();
        this.renderUI();
        this.refreshTiles();
        return result;
    }

    remove(id) {
        this.zones = privacyRemoveZone(this.zones, id);
        this.save();
        this.refreshMapLayer();
        this.renderUI();
        this.refreshTiles();
    }

    /* ---------------- 地図描画 ---------------- */

    getLayerGroup() {
        if (this.layerGroup || typeof L === 'undefined') return this.layerGroup;
        const map = this.app ? this.app.map : null;
        if (!map) return null;
        this.layerGroup = L.layerGroup().addTo(map);
        return this.layerGroup;
    }

    refreshMapLayer() {
        const group = this.getLayerGroup();
        if (!group || typeof L === 'undefined') return;
        for (const circle of this.circles.values()) {
            try { group.removeLayer(circle); } catch (e) { /* ignore */ }
        }
        this.circles.clear();
        this.zones.forEach((zone) => {
            const circle = L.circle([zone.lat, zone.lng], {
                radius: zone.radius,
                color: '#38bdf8',
                weight: 1,
                opacity: 0.75,
                dashArray: '4 6',
                fillColor: '#0ea5e9',
                fillOpacity: 0.06,
                interactive: false
            });
            circle.addTo(group);
            // 中心の目印（ずらした後の座標）
            const marker = L.circleMarker([zone.lat, zone.lng], {
                radius: 3,
                color: '#38bdf8',
                weight: 1.5,
                fillColor: '#0f172a',
                fillOpacity: 0.9,
                interactive: false
            });
            marker.addTo(group);
            this.circles.set(zone.id, circle);
            this.circles.set(`${zone.id}_dot`, marker);
        });
    }

    /** 区域の追加・削除のあと、描画済みマスを引き直す（区域の中は初期配置の見た目に戻す） */
    refreshTiles() {
        const grid = this.app ? this.app.gridManager : null;
        if (!grid) return;
        // 区域が変わるとブロックの多数決も変わるので、色キャッシュを捨ててから描き直す
        if (typeof grid.clearBlockTeamCache === 'function') grid.clearBlockTeamCache();
        if (typeof grid.updateGrids === 'function') grid.updateGrids();
    }

    /* ---------------- 地図タップで中心を指定 ---------------- */

    startPickOnMap() {
        const map = this.app ? this.app.map : null;
        if (!map) return false;
        this.pickMode = true;
        if (typeof this.app.closeModalsForPrivacyPick === 'function') {
            this.app.closeModalsForPrivacyPick();
        }
        if (typeof this.app.showToast === 'function') {
            this.app.showToast('地図をタップして中心を指定');
        }
        const handler = (e) => {
            map.off('click', handler);
            this.pickMode = false;
            this.openModal({ center: { lat: e.latlng.lat, lng: e.latlng.lng } });
        };
        map.once('click', handler);
        return true;
    }

    /* ---------------- 設定UI ---------------- */

    initUI() {
        this.modal = document.getElementById('privacy-modal');
        this.listEl = document.getElementById('privacy-zone-list');
        this.emptyEl = document.getElementById('privacy-zone-empty');
        this.countEl = document.getElementById('privacy-zone-count');
        this.labelInput = document.getElementById('input-privacy-label');
        this.pendingEl = document.getElementById('privacy-pending-center');
        this.addCurrentBtn = document.getElementById('btn-privacy-add-current');
        this.addMapBtn = document.getElementById('btn-privacy-add-map');
        this.closeBtn = document.getElementById('btn-close-privacy');
        this.closeIconBtn = document.getElementById('btn-close-privacy-icon');

        const openBtn = document.getElementById('btn-open-privacy');
        if (openBtn) {
            openBtn.addEventListener('click', () => {
                const menu = document.getElementById('menu-modal');
                if (menu) menu.classList.add('hidden');
                this.openModal();
            });
        }

        if (this.closeBtn) this.closeBtn.addEventListener('click', () => this.closeModal());
        if (this.closeIconBtn) this.closeIconBtn.addEventListener('click', () => this.closeModal());
        if (this.modal) {
            this.modal.addEventListener('click', (e) => {
                if (e.target === this.modal) this.closeModal();
            });
        }

        const radiusButtons = document.querySelectorAll('[data-privacy-radius]');
        radiusButtons.forEach((btn) => {
            btn.addEventListener('click', () => {
                this.setRadius(Number(btn.getAttribute('data-privacy-radius')));
            });
        });

        const presetButtons = document.querySelectorAll('[data-privacy-label]');
        presetButtons.forEach((btn) => {
            btn.addEventListener('click', () => {
                if (this.labelInput) this.labelInput.value = btn.getAttribute('data-privacy-label') || '';
            });
        });

        if (this.addCurrentBtn) {
            this.addCurrentBtn.addEventListener('click', () => this.addFromCurrentPosition());
        }
        if (this.addMapBtn) {
            this.addMapBtn.addEventListener('click', () => {
                this.closeModal();
                this.startPickOnMap();
            });
        }

        this.renderUI();
        this.refreshMapLayer();
        if (typeof window !== 'undefined') window.PrivacyZones = this;
    }

    openModal(options = {}) {
        if (!this.modal) return;
        this.pendingCenter = (options && options.center) ? { lat: options.center.lat, lng: options.center.lng } : null;
        if (this.labelInput && this.pendingCenter === null) this.labelInput.value = '';
        this.modal.classList.remove('hidden');
        this.renderUI();
    }

    closeModal() {
        if (!this.modal) return;
        this.modal.classList.add('hidden');
        this.pendingCenter = null;
    }

    addFromCurrentPosition() {
        const app = this.app;
        const pos = app && app.virtualPos ? app.virtualPos : null;
        if (!pos || !Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) {
            if (app && app.showToast) app.showToast('現在地が取得できていません');
            return;
        }
        const center = this.pendingCenter || { lat: pos[0], lng: pos[1] };
        this.addFromCenter(center);
    }

    addFromCenter(center) {
        const label = this.labelInput ? this.labelInput.value : '';
        const result = this.add({
            lat: center.lat,
            lng: center.lng,
            radius: this.radius,
            label,
            createdAt: Date.now()
        });

        if (!result.ok) {
            const app = this.app;
            if (app && app.showToast) {
                app.showToast(result.reason === 'max-zones'
                    ? `非表示ピンは最大${PRIVACY_MAX_ZONES}個までです`
                    : 'この地点には登録できません');
            }
            return result;
        }

        this.pendingCenter = null;
        if (this.labelInput) this.labelInput.value = '';
        const app = this.app;
        if (app && app.showToast) {
            app.showToast(`${result.zone.label}（半径${result.zone.radius}m）を登録しました`);
        }
        this.closeModal();
        return result;
    }

    renderUI() {
        if (typeof document === 'undefined') return;
        if (this.countEl) {
            this.countEl.textContent = `${this.zones.length} / ${PRIVACY_MAX_ZONES}`;
        }

        // 半径ボタンの選択状態
        const radiusButtons = document.querySelectorAll('[data-privacy-radius]');
        radiusButtons.forEach((btn) => {
            const value = Number(btn.getAttribute('data-privacy-radius'));
            const selected = value === this.radius;
            btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
            btn.dataset.selected = selected ? 'true' : 'false';
            btn.classList.toggle('privacy-selected', selected);
        });

        // 指定地点の表示（地図タップで決めたときだけ）
        if (this.pendingEl) {
            if (this.pendingCenter) {
                this.pendingEl.textContent = `指定地点: ${this.pendingCenter.lat.toFixed(5)}, ${this.pendingCenter.lng.toFixed(5)}`;
                this.pendingEl.classList.remove('hidden');
            } else {
                this.pendingEl.textContent = '';
                this.pendingEl.classList.add('hidden');
            }
        }

        if (this.addCurrentBtn) {
            this.addCurrentBtn.textContent = this.pendingCenter ? 'この地点で登録' : '現在地で登録';
        }

        // 一覧
        if (this.listEl) {
            this.listEl.innerHTML = '';
            this.zones.forEach((zone) => {
                const row = document.createElement('div');
                row.className = 'privacy-zone-row';

                const info = document.createElement('div');
                info.className = 'privacy-zone-info';
                const name = document.createElement('span');
                name.className = 'privacy-zone-name';
                name.textContent = zone.label;
                const meta = document.createElement('span');
                meta.className = 'privacy-zone-meta';
                meta.textContent = `半径 ${zone.radius}m`;
                info.appendChild(name);
                info.appendChild(meta);

                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'privacy-zone-delete';
                del.textContent = '削除';
                del.setAttribute('aria-label', `${zone.label}を削除`);
                del.addEventListener('click', () => this.remove(zone.id));

                row.appendChild(info);
                row.appendChild(del);
                this.listEl.appendChild(row);
            });

            if (this.emptyEl) {
                this.emptyEl.classList.toggle('hidden', this.zones.length > 0);
            }
        }

        const atLimit = !this.canAdd();
        [this.addCurrentBtn, this.addMapBtn].forEach((btn) => {
            if (!btn) return;
            btn.disabled = atLimit;
            btn.classList.toggle('opacity-40', atLimit);
        });
    }
}

/* Node のテストから読み込めるようにする（ブラウザでは module が無いので何もしない） */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        PRIVACY_STORAGE_KEY,
        PRIVACY_RADIUS_STORAGE_KEY,
        PRIVACY_MAX_ZONES,
        PRIVACY_RADIUS_OPTIONS,
        PRIVACY_DEFAULT_RADIUS,
        PRIVACY_JITTER_RATIO_MIN,
        PRIVACY_JITTER_RATIO_MAX,
        PRIVACY_LABEL_PRESETS,
        privacyDistanceMeters,
        privacyDestinationPoint,
        privacyJitterCenter,
        privacyNormalizeRadius,
        privacyNormalizeLabel,
        privacyNormalizeZones,
        privacyZoneContains,
        privacyFindZone,
        privacyAddZone,
        privacyRemoveZone,
        PrivacyZoneManager
    };
}
