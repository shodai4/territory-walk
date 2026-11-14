/**
 * TERRITORY WALK - pro.js
 * Pro Status Manager & Activation Logic
 */

class ProManager {
    constructor() {
        this.STORAGE_KEY = 'territory_pro_unlocked';
        this.VALID_CODES = ['TW-SUPPORTER-2026', 'SHODAI-PRO'];
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

    activateCode(code) {
        if (this.VALID_CODES.includes(code.trim())) {
            this.setPro(true);
            return true;
        }
        return false;
    }

    getSupporterBadgeHtml() {
        return `
            <span class="inline-flex items-center gap-0.5 bg-gradient-to-r from-amber-300 to-amber-600 text-[9px] font-bold text-black px-1.5 py-0.5 rounded shadow-sm">
                PRO SUPPORTER
            </span>
        `;
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
                if (modal) modal.classList.remove('hidden');
            });
        }

        const closeModal = () => {
            if (modal) modal.classList.add('hidden');
        };

        if (closeBtn) closeBtn.addEventListener('click', closeModal);
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) closeModal();
            });
        }

        if (activateBtn) {
            activateBtn.addEventListener('click', () => {
                const input = document.getElementById('input-pro-code');
                const code = input ? input.value : '';
                if (this.activateCode(code)) {
                    alert('Proサポーター機能が有効になりました！限定スキンとポスター出力をご利用いただけます。');
                    closeModal();
                    if (this.app) {
                        this.app.renderTeamBadge();
                        this.app.updateStatsDisplay();
                    }
                } else {
                    alert('無効なコードです。正しいアクティベーションコードを入力してください。');
                }
            });
        }
    }
}
