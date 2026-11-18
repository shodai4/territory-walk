/**
 * TERRITORY WALK - app.js
 * アプリ本体の入口。役割ごとの実装は app-config / app-core / app-map / app-stats /
 * app-actions / app-menus / app-geolocation / app-marking / app-tracking / app-gameplay に分割し、
 * このファイルではそれらを1つの TerritoryWalkApp にまとめて起動する。
 */

class TerritoryWalkApp extends TerritoryWalkAppGameplay {}

// Auto-start on DOMContentLoaded
//   iOS ではアプリを削除→再インストールしても Keychain に匿名IDが残る。
//   StatsManager は生成時に localStorage のIDを読むため、先に Keychain から復元して
//   localStorage へ書き戻してから TerritoryWalkApp を生成する。
//   （Web では localStorage をそのまま使うので、ここは何もしない安全なフォールバック）
document.addEventListener('DOMContentLoaded', () => {
    const start = () => {
        window.app = new TerritoryWalkApp();
    };

    if (typeof TWIdentity === 'undefined' || !TWIdentity || typeof TWIdentity.bootstrap !== 'function') {
        start();
        return;
    }

    TWIdentity.bootstrap()
        .then((result) => {
            window.__twIdentityBootstrap = result || null;
            if (result && result.restored) {
                console.log('[Identity] Restored anonymous identity from', result.source);
            }
            start();
        })
        .catch(() => {
            start();
        });
});
