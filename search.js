/**
 * TERRITORY WALK - search.js
 * Inline Map Search & Remote Territory Viewer Module (Google Maps Style)
 * Zero-emoji, strictly minimal and high-contrast dark UI design.
 * Powered by OpenStreetMap Nominatim Geocoding API (100% Free / No API Key required)
 */

class SearchManager {
    constructor(appInstance) {
        this.app = appInstance;
        this.container = null;
        this.input = null;
        this.resultsContainer = null;
        this.clearBtn = null;
        this.searchMarker = null;
        this.debounceTimer = null;
        this.isOpen = false;

        this.initDOM();
        this.initEvents();
    }

    initDOM() {
        this.container = document.getElementById('inline-search-container');
        this.input = document.getElementById('input-inline-search');
        this.resultsContainer = document.getElementById('inline-search-results');
        this.clearBtn = document.getElementById('btn-clear-inline-search');
    }

    initEvents() {
        // MENU内の地図検索ボタン -> MENUを閉じて検索入力にフォーカス
        const openMenuBtn = document.getElementById('btn-open-search-from-menu');
        if (openMenuBtn) {
            openMenuBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const menuModal = document.getElementById('menu-modal');
                if (menuModal) menuModal.classList.add('hidden');
                this.focusSearchInput();
            });
        }

        // 検索実行ボタン
        const submitBtn = document.getElementById('btn-submit-inline-search');
        if (submitBtn) {
            submitBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (this.input) this.performSearch(this.input.value);
            });
        }

        // 入力クリアボタン
        if (this.clearBtn && this.input) {
            this.clearBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.input.value = '';
                this.clearBtn.classList.add('hidden');
                if (this.resultsContainer) this.resultsContainer.classList.add('hidden');
                this.input.focus();
            });
        }

        // インプット変更（Debounce 500ms 自動検索 ＆ Enterキー対応）
        if (this.input) {
            this.input.addEventListener('input', (e) => {
                const query = e.target.value.trim();
                if (this.clearBtn) {
                    if (query.length > 0) this.clearBtn.classList.remove('hidden');
                    else this.clearBtn.classList.add('hidden');
                }

                clearTimeout(this.debounceTimer);
                if (query.length < 2) {
                    if (this.resultsContainer) this.resultsContainer.classList.add('hidden');
                    return;
                }

                this.debounceTimer = setTimeout(() => {
                    this.performSearch(query);
                }, 500);
            });

            this.input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    clearTimeout(this.debounceTimer);
                    this.performSearch(this.input.value);
                } else if (e.key === 'Escape') {
                    this.closeSearchBar();
                }
            });
        }
    }

    focusSearchInput() {
        if (this.input) {
            this.input.focus();
            if (this.input.value.trim().length >= 2) {
                this.performSearch(this.input.value);
            }
        }
    }

    toggleSearchBar() {
        this.focusSearchInput();
    }

    openSearchBar() {
        this.focusSearchInput();
    }

    closeSearchBar() {
        if (this.resultsContainer) {
            this.resultsContainer.classList.add('hidden');
        }
        if (this.input) {
            this.input.blur();
        }
    }

    /**
     * OpenStreetMap Nominatim Geocoding API Search
     */
    async performSearch(query) {
        if (!query || query.trim().length === 0) return;
        const q = query.trim();

        if (!this.resultsContainer) return;
        this.resultsContainer.classList.remove('hidden');
        this.resultsContainer.innerHTML = `
            <div class="py-3 text-center text-zinc-400 font-mono text-xs flex items-center justify-center gap-2">
                <span class="w-2 h-2 rounded-full bg-sky-400 animate-ping"></span>
                <span>[${q}] を検索中...</span>
            </div>
        `;

        try {
            const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&countrycodes=jp&limit=6&addressdetails=1`;
            const res = await fetch(url, {
                headers: {
                    'Accept-Language': 'ja,en',
                    'User-Agent': 'TerritoryWalk-SearchModule/2.0'
                }
            });

            if (!res.ok) throw new Error(`HTTP error ${res.status}`);
            const data = await res.json();
            this.renderSearchResults(data, q);
        } catch (err) {
            console.error('[Search] Geocoding API failed:', err);
            this.resultsContainer.innerHTML = `
                <div class="py-3 text-center text-red-400 font-mono text-xs">
                    検索に失敗しました。時間をおいて再試行してください。
                </div>
            `;
        }
    }

    renderSearchResults(items, query) {
        if (!this.resultsContainer) return;

        if (!items || items.length === 0) {
            this.resultsContainer.innerHTML = `
                <div class="py-3 text-center text-zinc-500 font-mono text-xs">
                    「${query}」に一致する場所が見つかりませんでした
                </div>
            `;
            return;
        }

        this.resultsContainer.innerHTML = items.map((item, idx) => {
            const displayName = item.display_name.split(',')[0] || item.display_name;
            const fullAddr = item.display_name;
            const lat = parseFloat(item.lat);
            const lng = parseFloat(item.lon);

            return `
                <div class="search-result-item bg-zinc-900/90 hover:bg-zinc-800 active:bg-zinc-700 p-2.5 rounded-lg border border-zinc-800/80 cursor-pointer flex items-center justify-between gap-2 transition-all active:scale-[0.98]" data-lat="${lat}" data-lng="${lng}" data-name="${displayName}">
                    <div class="min-w-0 flex-1">
                        <div class="font-bold text-xs text-zinc-100 flex items-center gap-1.5 truncate">
                            <span class="w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0"></span>
                            <span class="truncate">${displayName}</span>
                        </div>
                        <div class="text-[10px] text-zinc-400 font-mono truncate mt-0.5">${fullAddr}</div>
                    </div>
                    <span class="text-[10px] text-sky-400 font-mono font-bold shrink-0">移動 →</span>
                </div>
            `;
        }).join('');

        this.resultsContainer.querySelectorAll('.search-result-item').forEach(el => {
            el.addEventListener('click', (e) => {
                const target = e.currentTarget;
                const lat = parseFloat(target.dataset.lat);
                const lng = parseFloat(target.dataset.lng);
                const name = target.dataset.name;
                this.selectLocation(lat, lng, name);
            });
        });
    }

    /**
     * Location Selected -> Smooth flyTo, drop search marker, sync tiles, close search bar
     */
    selectLocation(lat, lng, displayName) {
        if (!this.app || !this.app.map) return;

        this.closeSearchBar();

        // 1. スムーズカメラ移動
        this.app.map.flyTo([lat, lng], 16, {
            duration: 1.2,
            easeLinearity: 0.25
        });

        // 2. 検索ピンマーカーの設置
        this.dropSearchMarker(lat, lng, displayName);

        // 3. 移動先エリアの陣地フェッチ
        if (this.app.gridManager && this.app.gridManager.fetchAndSyncTiles) {
            setTimeout(() => {
                this.app.gridManager.fetchAndSyncTiles();
            }, 300);
        }

        // 4. トースト通知
        if (this.app.showToast) {
            this.app.showToast(
                `${displayName} の塗り状況を表示中`,
                '右下の現在地ボタンを押すといつでもGPS位置へ復帰できます'
            );
        }
    }

    dropSearchMarker(lat, lng, label) {
        if (this.searchMarker && this.app.map) {
            this.app.map.removeLayer(this.searchMarker);
            this.searchMarker = null;
        }

        if (!window.L || !this.app.map) return;

        const iconHtml = `
            <div class="relative flex items-center justify-center">
                <span class="absolute w-8 h-8 rounded-full bg-sky-500/30 animate-ping"></span>
                <span class="relative w-4 h-4 rounded-full bg-sky-400 border-2 border-white shadow-xl flex items-center justify-center">
                    <span class="w-1.5 h-1.5 rounded-full bg-black"></span>
                </span>
            </div>
        `;

        const customIcon = window.L.divIcon({
            html: iconHtml,
            className: 'search-marker-icon',
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });

        this.searchMarker = window.L.marker([lat, lng], { icon: customIcon }).addTo(this.app.map);
        this.searchMarker.bindPopup(`
            <div class="font-mono text-xs text-zinc-900 font-bold p-1">
                <div>[遠隔地閲覧中]</div>
                <div class="text-sky-700">${label}</div>
            </div>
        `).openPopup();
    }

    clearSearchMarker() {
        if (this.searchMarker && this.app && this.app.map) {
            this.app.map.removeLayer(this.searchMarker);
            this.searchMarker = null;
        }
    }
}
