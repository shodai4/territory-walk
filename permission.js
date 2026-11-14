/**
 * TERRITORY WALK - permission.js
 * Location permission guidance banner (PERMISSION_DENIED).
 *
 * - Persistent, low-noise banner shown while location permission is denied
 *   (Web Geolocation API and Capacitor Geolocation error shapes are both handled).
 * - "×" hides it temporarily; a successful fix (permission granted) hides it automatically.
 * - Sits below the header, above the map, behind modals (z-[2000]) and toasts (z-[1500]).
 */

class LocationPermissionBanner {
    /**
     * @param {Document|null} doc
     * @param {{ onChange?: Function, retryHandler?: Function }} options
     */
    constructor(doc = null, options = {}) {
        this.doc = doc || (typeof document !== 'undefined' ? document : null);
        this.elementId = 'location-permission-banner';
        this.closeButtonId = 'btn-location-banner-close';
        this.retryButtonId = 'btn-location-banner-retry';

        this.el = null;
        this.isDenied = false;
        this.isDismissed = false;
        this.onChange = options.onChange || null;
        this.retryHandler = options.retryHandler || null;

        if (this.doc) {
            this.el = this.doc.getElementById(this.elementId);
            this.bindControls();
        }
    }

    /**
     * Web GeolocationPositionError: code === 1 (PERMISSION_DENIED).
     * Capacitor Geolocation rejects with other shapes: { code: 'PERMISSION_DENIED' },
     * { message: 'User denied Geolocation' }, 'Location permission was denied', etc.
     * BackgroundGeolocation プラグインは { code: 'NOT_AUTHORIZED' } で拒否を返す。
     */
    static isPermissionDeniedError(error) {
        if (!error) return false;

        const code = error.code;
        if (code === 1 || code === '1') return true;
        // PERMISSION_DENIED / NOT_AUTHORIZED（BackgroundGeolocation の拒否コード）
        if (typeof code === 'string' && /PERMISSION[_\s-]?DENIED|NOT[_\s-]?AUTHORI[ZS]ED/i.test(code)) return true;

        let message = '';
        if (typeof error === 'string') {
            message = error;
        } else {
            message = [error.message, error.errorMessage, error.name, typeof code === 'string' ? code : null]
                .filter((value) => typeof value === 'string')
                .join(' ');
        }
        if (!message) return false;

        if (/PERMISSION[_\s-]?DENIED/i.test(message)) return true;
        if (/NOT[_\s-]?AUTHORI[ZS]ED/i.test(message)) return true;
        if (/not\s+authori[sz]ed/i.test(message)) return true;
        if (/user\s+denied/i.test(message)) return true;
        if (/location\s+(permission|access|services?).{0,32}(denied|disabled|turned\s+off)/i.test(message)) return true;
        if (/(位置情報|ジオロケーション).{0,16}(許可|拒否|オフ|無効|利用でき)/.test(message)) return true;
        return false;
    }

    bindControls() {
        if (!this.doc) return;
        const closeBtn = this.doc.getElementById(this.closeButtonId);
        if (closeBtn && typeof closeBtn.addEventListener === 'function') {
            closeBtn.addEventListener('click', (event) => {
                if (event && typeof event.preventDefault === 'function') event.preventDefault();
                this.dismiss();
            });
        }
        const retryBtn = this.doc.getElementById(this.retryButtonId);
        if (retryBtn && typeof retryBtn.addEventListener === 'function') {
            retryBtn.addEventListener('click', (event) => {
                if (event && typeof event.preventDefault === 'function') event.preventDefault();
                this.retry();
            });
        }
    }

    isVisible() {
        return !!this.el && !this.el.classList.contains('hidden');
    }

    /**
     * Show the banner. Skipped while the player has dismissed it, unless force is set.
     * @returns {boolean} true when the banner actually became visible
     */
    show(options = {}) {
        this.isDenied = true;
        if (!this.el) return false;
        if (this.isDismissed && !options.force) return false;
        if (options.force) this.isDismissed = false;
        if (this.isVisible()) return false;

        this.el.classList.remove('hidden');
        this.position();
        this.notify(true);
        return true;
    }

    hide() {
        if (!this.el || !this.isVisible()) return false;
        this.el.classList.add('hidden');
        this.notify(false);
        return true;
    }

    /** 「×」: hide temporarily, stay hidden until permission is granted or the player retries. */
    dismiss() {
        this.isDismissed = true;
        this.hide();
    }

    /** A successful position fix proves permission is granted: hide and reset the state. */
    handlePermissionGranted() {
        const wasActive = this.isDenied || this.isDismissed || this.isVisible();
        this.isDenied = false;
        this.isDismissed = false;
        this.hide();
        return wasActive;
    }

    /** 「再確認」: clear the dismissal and ask for a fresh fix through the host app. */
    retry() {
        this.isDismissed = false;
        if (typeof this.retryHandler === 'function') {
            this.retryHandler();
            return;
        }
        if (typeof navigator === 'undefined' || !navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition(
            () => this.handlePermissionGranted(),
            (error) => {
                if (LocationPermissionBanner.isPermissionDeniedError(error)) this.show({ force: true });
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    }

    /**
     * Ask the Permissions API for the current state so an already-denied permission
     * shows the banner before the first error arrives, and a granted one clears it.
     */
    refreshPermissionState() {
        try {
            if (typeof navigator === 'undefined' || !navigator.permissions || !navigator.permissions.query) return;
            navigator.permissions.query({ name: 'geolocation' })
                .then((status) => {
                    if (!status) return;
                    if (status.state === 'granted') {
                        this.handlePermissionGranted();
                    } else if (status.state === 'denied') {
                        this.show();
                    }
                })
                .catch(() => { /* Permissions API unsupported: fall back to error handling */ });
        } catch (e) { /* ignore */ }
    }

    /** Place the banner directly under the header (its height varies with the safe area). */
    position() {
        if (!this.el || !this.el.style) return;
        let top = 168;
        try {
            const header = this.doc && typeof this.doc.querySelector === 'function'
                ? this.doc.querySelector('header')
                : null;
            if (header && typeof header.getBoundingClientRect === 'function') {
                const rect = header.getBoundingClientRect();
                if (rect && rect.height > 0) top = Math.round(rect.bottom + 8);
            }
        } catch (e) { /* fallback to default */ }
        this.el.style.top = `${Math.max(top, 64)}px`;
    }

    notify(visible) {
        if (typeof this.onChange !== 'function') return;
        try {
            this.onChange(visible);
        } catch (e) { /* ignore listener errors */ }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LocationPermissionBanner };
}
