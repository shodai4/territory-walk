/**
 * TERRITORY WALK - search.js
 * Map Location Search & Remote Territory Territory Viewer Module
 * Powered by OpenStreetMap Nominatim Geocoding API (100% Free / No API Key required)
 */

class SearchManager {
    constructor(appInstance) {
        this.app = appInstance;
        this.modal = null;
        this.input = null;
        this.resultsContainer = null;
        this.clearBtn = null;
        this.searchMarker = null;
        this.debounceTimer = null;

        // 日本の主要エリア・クイックジャンププリセット (0msで即時ジャンプ可能)
        this.quickLocations = [
            { name: '東大阪市', desc: '大阪府東大阪市 (本拠地)', lat: 34.6654, lng: 135.6025 },
            { name: '梅田駅', desc: '大阪府大阪市北区', lat: 34.7024, lng: 135.4959 },
            { name: 'なんば駅', desc: '大阪府大阪市中央区', lat: 34.6669, lng: 135.5013 },
            { name: '天王寺駅', desc: '大阪府大阪市天王寺区', lat: 34.6472, lng: 135.5139 },
            { name: '渋谷駅', desc: '東京都渋谷区', lat: 35.6580, lng: 139.7016 },
            { name: '新宿駅', desc: '東京都新宿区', lat: 35.6896, lng: 139.7005 },
            { name: '秋葉原駅', desc: '東京都千代田区', lat: 35.6983, lng: 139.7731 },
            { name: '京都駅', desc: '京都府京都市下京区', lat: 34.9858, lng: 135.7588 }
        ];

        this.initDOM();
        this.initEvents();
    }

    initDOM() {
        this.modal = document.getElementById('search-modal');
        this.input = document.getElementById('search-input');
        this.resultsContainer = document.getElementById('search-results-list');
        this.clearBtn = document.getElementById('btn-clear-search');
        this.renderQuickPresets();
    }

    initEvents() {
        // 開くボタン（マップ上フローティング ＆ MENU内）
        const openFloatingBtn = document.getElementById('btn-open-search');
        const openMenuBtn = document.getElementById('btn-open-search-from-menu');

        if (openFloatingBtn) {
            openFloatingBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.openModal();
            });
        }

        if (openMenuBtn) {
            openMenuBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const menuModal = document.getElementById('menu-modal');
                if (menuModal) menuModal.classList.add('hidden');
                this.openModal();
            });
        }

        // 閉じるボタン
        const closeBtn = document.getElementById('btn-close-search-modal');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.closeModal());
        }

        if (this.modal) {
            this.modal.addEventListener('click', (e) => {
                if (e.target === this.modal) {
                    this.closeModal();
                }
            });
        }

        // 検索実行ボタン
        const execBtn = document.getElementById('btn-exec-search');
        if (execBtn) {
            execBtn.addEventListener('click', () => {
                if (this.input) this.performSearch(this.input.value);
            });
        }

        // Enterキーで検索実行 ＆ クリアボタン制御
        if (this.input) {
            this.input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.performSearch(this.input.value);
                }
            });

            this.input.addEventListener('input', () => {
                const val = this.input.value.trim();
                if (this.clearBtn) {
                    if (val.length > 0) {
                        this.clearBtn.classList.remove('hidden');
                    } else {
                        this.clearBtn.classList.add('hidden');
                    }
                }

                // 2文字以上で500msのdebounceインクリメンタル検索
                clearTimeout(this.debounceTimer);
                if (val.length >= 2) {
                    this.debounceTimer = setTimeout(() => {
                        this.performSearch(val);
                    }, 500);
                }
            });
        }

        // クリアボタン押下
        if (this.clearBtn) {
            this.clearBtn.addEventListener('click', () => {
                if (this.input) {
                    this.input.value = '';
                    this.input.focus();
                }
                this.clearBtn.classList.add('hidden');
                this.renderDefaultState();
            });
        }
    }

    openModal() {
        if (!this.modal) return;
        this.modal.classList.remove('hidden');
        if (this.input) {
            setTimeout(() => {
                this.input.focus();
            }, 100);
        }
    }

    closeModal() {
        if (!this.modal) return;
        this.modal.classList.add('hidden');
    }

    renderQuickPresets() {
        const container = document.getElementById('search-quick-presets');
        if (!container) return;

        container.innerHTML = '';
        this.quickLocations.forEach(loc => {
            const btn = document.createElement('button');
            btn.className = 'px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 rounded-lg text-xs font-mono text-zinc-200 transition-all active:scale-95 text-left flex flex-col justify-center';
            btn.innerHTML = `
                <span class="font-bold text-white text-[11px]">${loc.name}</span>
                <span class="text-[9px] text-zinc-400 truncate">${loc.desc}</span>
            `;
            btn.addEventListener('click', () => {
                this.jumpTo(loc.lat, loc.lng, loc.name);
            });
            container.appendChild(btn);
        });
    }

    renderDefaultState() {
        if (!this.resultsContainer) return;
        this.resultsContainer.innerHTML = `
            <div class="text-center py-6 text-zinc-500 font-mono text-xs">
                <div>地名や駅名を入力して検索</div>
                <div class="text-[10px] text-zinc-600 mt-1">上の人気エリアからワンタップで移動することもできます</div>
            </div>
        `;
    }

    renderLoading() {
        if (!this.resultsContainer) return;
        this.resultsContainer.innerHTML = `
            <div class="text-center py-6 text-zinc-400 font-mono text-xs flex flex-col items-center justify-center gap-2">
                <svg class="animate-spin h-5 w-5 text-sky-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span>検索中...</span>
            </div>
        `;
    }

    renderError(message) {
        if (!this.resultsContainer) return;
        this.resultsContainer.innerHTML = `
            <div class="text-center py-4 text-red-400 font-mono text-xs">
                ${message}
            </div>
        `;
    }

    async performSearch(query) {
        const trimmed = (query || '').trim();
        if (!trimmed) {
            this.renderDefaultState();
            return;
        }

        this.renderLoading();

        try {
            // 日本国内（countrycodes=jp）限定で正確な候補を最大6件取得
            const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(trimmed)}&countrycodes=jp&addressdetails=1&limit=6`;
            
            const res = await fetch(url, {
                headers: {
                    'Accept': 'application/json'
                }
            });

            if (!res.ok) {
                throw new Error(`HTTP Error: ${res.status}`);
            }

            const data = await res.json();
            this.renderResults(data, trimmed);
        } catch (err) {
            console.error('Nominatim search error:', err);
            this.renderError('検索に失敗しました。時間をおいて再試行してください。');
        }
    }

    renderResults(results, query) {
        if (!this.resultsContainer) return;

        if (!results || results.length === 0) {
            this.resultsContainer.innerHTML = `
                <div class="text-center py-6 text-zinc-500 font-mono text-xs">
                    <div>「${query}」に一致する場所が見つかりませんでした</div>
                    <div class="text-[10px] text-zinc-600 mt-1">駅名や市区町村名を変えてお試しください</div>
                </div>
            `;
            return;
        }

        this.resultsContainer.innerHTML = '';
        const list = document.createElement('div');
        list.className = 'space-y-1.5';

        results.forEach(item => {
            const lat = parseFloat(item.lat);
            const lng = parseFloat(item.lon);
            
            // 地名と住所の整形
            const displayNameParts = (item.display_name || '').split(',').map(s => s.trim());
            const primaryName = item.name || displayNameParts[0] || '不明な地点';
            
            // 残りの部分から住所を構築（日本は除外）
            const addressParts = displayNameParts.filter(p => p !== primaryName && p !== '日本' && !/^[0-9]{3}-[0-9]{4}$/.test(p));
            const subAddress = addressParts.slice(0, 3).join(', ') || '日本国内';

            const itemEl = document.createElement('div');
            itemEl.className = 'p-2.5 bg-zinc-950 hover:bg-zinc-800/80 active:bg-zinc-700/80 border border-zinc-800 hover:border-zinc-600 rounded-xl transition-all cursor-pointer flex items-center justify-between gap-2.5';
            itemEl.innerHTML = `
                <div class="flex-1 min-w-0">
                    <div class="font-bold text-xs text-white truncate font-mono">${primaryName}</div>
                    <div class="text-[10px] text-zinc-400 truncate mt-0.5">${subAddress}</div>
                </div>
                <div class="px-2.5 py-1 bg-sky-500/20 text-sky-400 border border-sky-500/40 rounded-lg text-[10px] font-mono font-bold shrink-0 flex items-center gap-1">
                    <span>見る</span>
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
                </div>
            `;

            itemEl.addEventListener('click', () => {
                this.jumpTo(lat, lng, primaryName);
            });

            list.appendChild(itemEl);
        });

        this.resultsContainer.appendChild(list);
    }

    jumpTo(lat, lng, displayName) {
        this.closeModal();
        if (this.app && typeof this.app.jumpToLocation === 'function') {
            this.app.jumpToLocation(lat, lng, displayName);
        }
    }

    setSearchMarker(lat, lng, displayName) {
        this.clearSearchMarker();

        if (!this.app || !this.app.map || typeof L === 'undefined') return;

        const customIcon = L.divIcon({
            className: 'search-target-marker',
            html: `
                <div class="relative flex items-center justify-center">
                    <span class="absolute w-8 h-8 rounded-full bg-sky-400/40 animate-ping"></span>
                    <span class="w-4 h-4 rounded-full bg-sky-400 border-2 border-black shadow-lg"></span>
                </div>
            `,
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });

        this.searchMarker = L.marker([lat, lng], { icon: customIcon }).addTo(this.app.map);
        this.searchMarker.bindPopup(`
            <div class="text-white font-mono text-xs p-1">
                <div class="font-bold text-sky-400">${displayName}</div>
                <div class="text-[10px] text-zinc-300 mt-0.5">遠隔地閲覧中</div>
            </div>
        `, {
            className: 'dark-popup',
            closeButton: false
        }).openPopup();
    }

    clearSearchMarker() {
        if (this.searchMarker && this.app && this.app.map) {
            this.app.map.removeLayer(this.searchMarker);
            this.searchMarker = null;
        }
    }
}
