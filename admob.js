/**
 * TERRITORY WALK - admob.js
 * Google AdMob Native Integration for iOS (Capacitor) & Web Simulator Fallback
 *
 * 【本番ID（Google AdMob で 2026-11-15 発行）】
 *   App ID  : ca-app-pub-5739782559889389~3477680072  … Info.plist の GADApplicationIdentifier
 *                                                      （scripts/configure-ios.js が設定）
 *   バナー  : ca-app-pub-5739782559889389/9566456603
 *   リワード: ca-app-pub-5739782559889389/9650217089
 *
 * 【テスト広告 / 本番広告の切り替え＝1か所だけ】
 *   CONFIG.ENABLE_DEBUG_TOOLS（app.js）がそのままスイッチになる。
 *     true  … 開発中・TestFlight 実機テスト中。isTesting: true で Google 公式テスト広告を配信
 *             （@capacitor-community/admob の iOS 側 getAdId() が、isTesting が真なら
 *               公式テストユニットIDに差し替える。収益も発生せず、無効トラフィックにもならない）
 *     false … App Store 提出ビルド。isTesting: false で上記の本番ユニットIDから本番広告を配信
 *
 *   本番ユニットIDのまま実機で自分の広告を表示・クリックすると「無効トラフィック」で
 *   AdMob アカウントが停止され得るため、広告リクエストには必ず isTesting を必ず添える
 *   （buildAdOptions() / buildInitializeOptions() を経由させる）。
 *   提出時は app.js の ENABLE_DEBUG_TOOLS を false にするだけでよい（本ファイルは触らない）。
 */

/**
 * 本番広告ユニット。値は Google AdMob 管理画面の発行値そのもの。
 * （Info.plist の App ID は scripts/configure-ios.js の GADApplicationIdentifier と一致させる）
 */
const ADMOB_AD_UNITS = Object.freeze({
    appId: 'ca-app-pub-5739782559889389~3477680072',
    banner: 'ca-app-pub-5739782559889389/9566456603',
    reward: 'ca-app-pub-5739782559889389/9650217089'
});

/**
 * テストデバイス（initialize の testingDevices）。
 * initializeForTesting: true のときだけ SDK に渡す。実機のハッシュが分かったら追記する。
 */
const ADMOB_TESTING_DEVICES = Object.freeze(['2077ef9a63d2b398840261c8221a0c9b']);

/**
 * いま「テスト広告モード」で動くべきか。
 * CONFIG が無い環境（単体テスト・Webシミュレータ）は安全側＝テスト配信に倒す。
 * @returns {boolean}
 */
function isAdMobTestingMode() {
    if (typeof CONFIG === 'undefined' || CONFIG === null) return true;
    return CONFIG.ENABLE_DEBUG_TOOLS !== false;
}

class AdMobManager {
    constructor(appInstance, options = {}) {
        this.app = appInstance;
        this.isNative = typeof window !== 'undefined'
            && typeof window.Capacitor !== 'undefined'
            && typeof window.Capacitor.isNativePlatform === 'function'
            && window.Capacitor.isNativePlatform();
        this.admob = null;
        this.isAdLoaded = false;
        this.initStarted = false;

        this.applyPlatformVisibility();

        // 初回起動ゲート（startup-gate.js）が「ゲームをはじめる」まで待たせる場合、
        // 呼び出し側は deferInit: true で生成し、後から init() を呼ぶ。
        // （initialize は ATT の許可要求を含むため、ルール説明より先に出さない）
        if (!options.deferInit) this.init();
    }

    /**
     * テスト広告モードか（CONFIG.ENABLE_DEBUG_TOOLS に常に連動。毎回読み直すので
     * 実行中にフラグを切り替えても次のリクエストから効く）。
     */
    get isTesting() {
        return isAdMobTestingMode();
    }

    /** 本番バナー広告ユニットID */
    get bannerAdId() {
        return ADMOB_AD_UNITS.banner;
    }

    /** 本番リワード動画広告ユニットID */
    get rewardAdId() {
        return ADMOB_AD_UNITS.reward;
    }

    /**
     * 広告リクエスト共通オプション。isTesting を必ず載せることで、
     * 実機テスト中の誤クリックが本番広告の無効トラフィックとして計上されるのを防ぐ。
     * @returns {{isTesting: boolean}}
     */
    buildAdOptions() {
        return { isTesting: this.isTesting };
    }

    /**
     * initialize に渡すオプション。テスト中だけ testingDevices を登録する。
     * @returns {{requestTrackingAuthorization: boolean, initializeForTesting: boolean, testingDevices?: string[]}}
     */
    buildInitializeOptions() {
        const testing = this.isTesting;
        const options = {
            requestTrackingAuthorization: true,
            initializeForTesting: testing
        };
        if (testing) options.testingDevices = [...ADMOB_TESTING_DEVICES];
        return options;
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
        // 初回起動ゲートから後追いで呼ばれるため、二重初期化（ATTの二重要求）を防ぐ
        if (this.initStarted) return;
        this.initStarted = true;

        if (!this.isNative) {
            console.log('[AdMob] Running in Web mode. Using simulation fallback.');
            return;
        }

        try {
            if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AdMob) {
                this.admob = window.Capacitor.Plugins.AdMob;

                // Initialize AdMob（テスト中は initializeForTesting + testingDevices）
                await this.admob.initialize(this.buildInitializeOptions());
                console.log(`[AdMob] Native AdMob initialized successfully. (testing=${this.isTesting})`);

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
                ...this.buildAdOptions(),
                adId: this.rewardAdId
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
        const coinManager = this.app && this.app.coinManager;
        if (coinManager && typeof coinManager.showRewardAdModal === 'function') {
            coinManager.showRewardAdModal(onSuccess);
        } else if (coinManager && typeof coinManager.startRewardAdSimulation === 'function') {
            // 旧インターフェース互換
            coinManager.startRewardAdSimulation(onSuccess);
        } else {
            // モーダルが使えない環境でもリワードを失わない
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
                        ...this.buildAdOptions(),
                        adId: this.bannerAdId,
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
