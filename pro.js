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

    activateCode(code) {
        if (this.VALID_CODES.includes(code.trim())) {
            localStorage.setItem(this.STORAGE_KEY, 'true');
            return true;
        }
        return false;
    }

    getSupporterBadgeHtml() {
        return `
            <span class="inline-flex items-center gap-0.5 bg-gradient-to-r from-amber-300 to-amber-600 text-[9px] font-bold text-black px-1.5 py-0.5 rounded shadow-sm">
                ★ SUPPORTER
            </span>
        `;
    }
}
