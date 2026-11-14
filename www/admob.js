/**
 * TERRITORY WALK - admob.js
 * Google AdMob Native Integration for iOS (Capacitor) & Web Simulator Fallback
 */

class AdMobManager {
    constructor(appInstance) {
        this.app = appInstance;
        this.isNative = typeof window.Capacitor !== 'undefined'
            && typeof window.Capacitor.isNativePlatform === 'function'
            && window.Capacitor.isNativePlatform();
        this.admob = null;
        this.isAdLoaded = false;
        this.testRewardAdId = 'ca-app-pub-3940256099942544/1712485313'; // Google Official Test Reward Ad ID for iOS
        this.testBannerAdId = 'ca-app-pub-3940256099942544/2934735716'; // Google Official Test Banner Ad ID for iOS

        this.applyPlatformVisibility();
        this.init();
    }

    /**
     * ネイティブ実行時はWeb用のダミー広告枠を常に非表示にする
     * （AdMobネイティブバナーとの二重表示防止）。Webブラウザでは従来どおり表示。
     */
    applyPlatformVisibility() {
        if (this.isNative) {
            document.body.setAttribute('data-platform', 'native');
            const webBanner = document.getElementById('banner-ad-container');
            if (webBanner) webBanner.classList.add('hidden');
        } else {
            document.body.removeAttribute('data-platform');
        }
    }

    /** AdMobネイティブバナー分の下部余白を確保／解除する */
    setNativeBannerVisible(visible) {
        if (!this.isNative) {
            document.body.removeAttribute('data-native-banner');
            return;
        }
        if (visible) {
            document.body.setAttribute('data-native-banner', 'true');
        } else {
            document.body.removeAttribute('data-native-banner');
        }
    }

    async init() {
        if (!this.isNative) {
            console.log('[AdMob] Running in Web mode. Using simulation fallback.');
            return;
        }

        try {
            if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AdMob) {
                this.admob = window.Capacitor.Plugins.AdMob;
                
                // Initialize AdMob
                await this.admob.initialize({
                    requestTrackingAuthorization: true,
                    testingDevices: ['2077ef9a63d2b398840261c8221a0c9b'],
                    initializeForTesting: true
                });
                console.log('[AdMob] Native AdMob initialized successfully.');

                // Prepare first reward video
                this.preloadRewardVideo();

                // 起動時の広告状態（Ad-Freeなら非表示、未購入ならバナー表示）を適用
                const adFree = this.app && this.app.coinManager ? this.app.coinManager.isAdFree() : false;
                await this.updateAdFreeState(adFree);
            } else {
                console.log('[AdMob] Native AdMob plugin not found in window.Capacitor.Plugins.');
            }
        } catch (err) {
            console.warn('[AdMob] Initialization warning:', err);
        }
    }

    async preloadRewardVideo() {
        if (!this.admob) return;

        try {
            await this.admob.prepareRewardVideoAd({
                adId: this.testRewardAdId
            });
            this.isAdLoaded = true;
            console.log('[AdMob] Reward video preloaded and ready.');
        } catch (err) {
            console.warn('[AdMob] Failed to preload reward video:', err);
            this.isAdLoaded = false;
        }
    }

    /**
     * Show Reward Video Ad and trigger callback on completion
     */
    async showRewardVideo(onSuccess, onFailure) {
        if (this.isNative && this.admob) {
            try {
                // Register reward earned listener
                const rewardSub = this.admob.addListener('onRewardedVideoAdReward', (reward) => {
                    console.log('[AdMob] Reward earned event received:', reward);
                    if (typeof onSuccess === 'function') onSuccess();
                    rewardSub.remove();
                    this.preloadRewardVideo(); // Preload next
                });

                const dismissSub = this.admob.addListener('onRewardedVideoAdDismissed', () => {
                    console.log('[AdMob] Reward video dismissed.');
                    dismissSub.remove();
                    this.preloadRewardVideo();
                });

                const failSub = this.admob.addListener('onRewardedVideoAdFailedToShow', (err) => {
                    console.error('[AdMob] Failed to show reward video:', err);
                    failSub.remove();
                    if (typeof onFailure === 'function') onFailure(err);
                });

                await this.admob.showRewardVideoAd();
            } catch (err) {
                console.warn('[AdMob] Error showing native ad, falling back to simulator:', err);
                this.showWebSimulator(onSuccess);
            }
        } else {
            // Web simulation mode
            this.showWebSimulator(onSuccess);
        }
    }

    showWebSimulator(onSuccess) {
        if (this.app && this.app.coinManager) {
            this.app.coinManager.showRewardAdModal(onSuccess);
        } else {
            if (typeof onSuccess === 'function') onSuccess();
        }
    }

    /**
     * Show or Hide AdMob Bottom Banner depending on Ad-Free status
     */
    async updateAdFreeState(isAdFree) {
        // Web用ダミー広告枠: ネイティブでは常に非表示、WebではAd-Free時のみ非表示
        const webBanner = document.getElementById('banner-ad-container');
        if (webBanner) {
            const hideWebBanner = this.isNative ? true : !!isAdFree;
            webBanner.classList.toggle('hidden', hideWebBanner);
        }

        if (!this.isNative) {
            this.setNativeBannerVisible(false);
            return;
        }

        if (isAdFree) {
            // 下部余白の解除 → AdMobバナーを非表示
            this.setNativeBannerVisible(false);
            if (this.admob) {
                try {
                    await this.admob.hideBanner();
                } catch (e) {
                    console.warn('[AdMob] Failed to hide banner:', e);
                }
                try {
                    if (typeof this.admob.removeBanner === 'function') await this.admob.removeBanner();
                } catch (e) { /* removeBanner is optional */ }
            }
        } else {
            if (this.admob) {
                try {
                    await this.admob.showBanner({
                        adId: this.testBannerAdId,
                        adSize: 'BANNER',
                        position: 'BOTTOM_CENTER',
                        margin: 0
                    });
                    this.setNativeBannerVisible(true);
                } catch (e) {
                    console.warn('[AdMob] Failed to show native banner:', e);
                    this.setNativeBannerVisible(false);
                }
            }
        }
    }
}
