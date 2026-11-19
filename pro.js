/**
 * TERRITORY WALK - pro.js
 * Pro Status Manager & Activation Logic
 *
 * v1.1: 有効なサポーターコードはアプリに埋め込まない。
 *   Supabase の RPC `verify_pro_code(input_code)` に問い合わせ、返ってきた true/false だけで
 *   判定する（DBには最新の1本だけが入り、毎週月曜に自動で上書きされる）。
 *   以前アプリに埋め込んでいた固定コードは撤去した（クライアント側には1つも残さない）。
 */

class ProManager {
    constructor() {
        this.STORAGE_KEY = 'territory_pro_unlocked';
        // Supabase RPC 名（supabase/pro_code.sql で定義）
        this.RPC_NAME = 'verify_pro_code';
        this.REQUEST_TIMEOUT_MS = 8000;
        this.app = null;
        this.client = null;
    }

    isPro() {
        return localStorage.getItem(this.STORAGE_KEY) === 'true';
    }

    /**
     * Pro状態を切り替える。
     * 以前のコードは `proManager.isPro = false` とメソッド自体を真偽値で上書きしており、
     * 以後 `isPro()` の全呼び出しが TypeError になってショップが開かなくなっていた。
     * 状態の変更は必ずこのメソッド（保存キーの付け外し）で行う。
     */
    setPro(enabled) {
        try {
            if (enabled) {
                localStorage.setItem(this.STORAGE_KEY, 'true');
            } else {
                localStorage.removeItem(this.STORAGE_KEY);
            }
        } catch (e) {
            console.warn('[Pro] Failed to update pro state:', e);
        }
        return !!enabled;
    }

    /**
     * Supabase クライアントを返す（アプリが持っているものを優先し、無ければ作る）。
     * 取得できなければ null（照合できないので Pro にはしない）。
     */
    getClient() {
        if (this.client) return this.client;

        const app = this.app || (typeof window !== 'undefined' ? window.app : null);
        const fromApp = app && app.supabaseManager && app.supabaseManager.client;
        if (fromApp) {
            this.client = fromApp;
            return this.client;
        }

        try {
            const hasLib = typeof window !== 'undefined' && window.supabase
                && typeof window.supabase.createClient === 'function';
            const hasConfig = typeof SUPABASE_URL === 'string' && SUPABASE_URL
                && typeof SUPABASE_ANON_KEY === 'string' && SUPABASE_ANON_KEY;
            if (hasLib && hasConfig) {
                this.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
                return this.client;
            }
        } catch (e) {
            console.warn('[Pro] Failed to create the Supabase client:', e);
        }

        return null;
    }

    /**
     * サポーターコードを照合して Pro を有効化する。
     * 判定は Supabase RPC のみ（クライアント側に有効コードは無い）。
     * @param {string} code
     * @returns {Promise<boolean>} 有効なら true（保存キーを立てる）
     */
    async activateCode(code) {
        const input = String(code == null ? '' : code).trim();
        if (!input) return false;

        const client = this.getClient();
        if (!client || typeof client.rpc !== 'function') {
            console.warn('[Pro] Supabase client is not available; the code cannot be verified.');
            return false;
        }

        try {
            const pending = client.rpc(this.RPC_NAME, { input_code: input });
            const result = await this.withTimeout(pending, this.REQUEST_TIMEOUT_MS);

            if (!result) {
                console.warn('[Pro] Verification timed out.');
                return false;
            }
            if (result.error) {
                console.warn('[Pro] Verification failed:', result.error);
                return false;
            }
            if (result.data === true || result.data === 'true') {
                this.setPro(true);
                return true;
            }
            return false;
        } catch (e) {
            console.warn('[Pro] Verification error:', e);
            return false;
        }
    }

    /** 応答が返らないときに画面を固めないための上限（結果は null） */
    withTimeout(promise, ms) {
        if (!promise || typeof promise.then !== 'function') return Promise.resolve(promise);
        return Promise.race([
            Promise.resolve(promise),
            new Promise((resolve) => setTimeout(() => resolve(null), ms))
        ]);
    }

    getSupporterBadgeHtml() {
        return `
            <span class="inline-flex items-center gap-0.5 bg-gradient-to-r from-amber-300 to-amber-600 text-[9px] font-bold text-black px-1.5 py-0.5 rounded shadow-sm">
                PRO SUPPORTER
            </span>
        `;
    }

    /**
     * 背後のSHOP（#shop-modal）が開いているとき、Pro状態の変化をSHOPの表示へ即座に反映する。
     * コード入力はSHOPの上に重ねて開くので、有効化後は「未登録」→「有効」や
     * スキン・特典・購入UIの解放状態を、閉じたSHOP側でもそのまま見せる必要がある。
     * @returns {boolean} SHOPへ反映したか（SHOPが閉じていればfalse）
     */
    refreshShopAfterProChange() {
        const shop = document.getElementById('shop-modal');
        if (!shop || (shop.classList && shop.classList.contains('hidden'))) return false;

        const coinManager = (this.app && this.app.coinManager)
            || (typeof window !== 'undefined' ? window.coinManager : null);
        if (!coinManager) return false;

        try {
            if (typeof coinManager.updateCoinCounts === 'function') coinManager.updateCoinCounts();
        } catch (e) {
            console.warn('[Pro] Coin counter refresh skipped:', e);
        }
        try {
            if (typeof coinManager.renderShopPanels === 'function') coinManager.renderShopPanels();
            else if (typeof coinManager.updateCoinUI === 'function') coinManager.updateCoinUI();
        } catch (e) {
            console.warn('[Pro] Shop refresh skipped:', e);
        }

        return true;
    }

    initModal(app) {
        this.app = app;
        const modal = document.getElementById('pro-modal');
        const openBtn = document.getElementById('btn-open-pro-modal');
        const closeBtn = document.getElementById('btn-close-pro');
        const activateBtn = document.getElementById('btn-activate-pro');

        if (openBtn) {
            openBtn.addEventListener('click', () => {
                if (this.app && this.app.menuModal) this.app.menuModal.classList.add('hidden');
                // MENUからの単独表示では、SHOPの上に重ねたときの薄い幕を外す
                if (modal && modal.classList) modal.classList.remove('pro-over-shop');
                if (modal) modal.classList.remove('hidden');
            });
        }

        const closeModal = () => {
            if (!modal) return;
            modal.classList.add('hidden');
            if (modal.classList) modal.classList.remove('pro-over-shop');
        };

        if (closeBtn) closeBtn.addEventListener('click', closeModal);
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) closeModal();
            });
        }

        if (activateBtn) {
            activateBtn.addEventListener('click', async () => {
                const input = document.getElementById('input-pro-code');
                const code = input ? input.value : '';

                // 通信中は二重送信を止める（RPC は毎回サーバーに聞く）
                const label = activateBtn.textContent;
                activateBtn.disabled = true;
                activateBtn.textContent = '確認中…';

                let ok = false;
                try {
                    ok = await this.activateCode(code);
                } finally {
                    activateBtn.disabled = false;
                    activateBtn.textContent = label;
                }

                if (ok) {
                    alert('Proサポーター機能が有効になりました！限定スキンとポスター出力をご利用いただけます。');
                    closeModal();
                    if (this.app) {
                        if (typeof this.app.renderTeamBadge === 'function') this.app.renderTeamBadge();
                        if (typeof this.app.updateStatsDisplay === 'function') this.app.updateStatsDisplay();
                    }
                    // SHOPを開いたまま有効化した場合は、背後のSHOP表示も即座に更新する
                    this.refreshShopAfterProChange();
                } else {
                    alert('無効なコードです。正しいアクティベーションコードを入力してください。');
                }
            });
        }
    }
}
