/**
 * TERRITORY WALK - admob.js
 * Google AdMob Native Integration for iOS (Capacitor) & Web Simulator Fallback
 */

class AdMobManager {
    constructor(appInstance) {
        this.app = appInstance;
        this.isNative = typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform();
        this.admob = null;
        this.isAdLoaded = false;
        this.testRewardAdId = 'ca-app-pub-3940256099942544/1712485313'; // Google Official Test Reward Ad ID for iOS
        this.testBannerAdId = 'ca-app-pub-3940256099942544/2934735716'; // Google Official Test Banner Ad ID for iOS

        this.init();
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
        if (isAdFree) {
            if (this.isNative && this.admob) {
                try {
                    await this.admob.hideBanner();
                } catch (e) {
                    console.warn('[AdMob] Failed to hide banner:', e);
                }
            }
        } else {
            if (this.isNative && this.admob) {
                try {
                    await this.admob.showBanner({
                        adId: this.testBannerAdId,
                        adSize: 'BANNER',
                        position: 'BOTTOM_CENTER',
                        margin: 0
                    });
                } catch (e) {
                    console.warn('[AdMob] Failed to show native banner:', e);
                }
            }
        }
    }
}
