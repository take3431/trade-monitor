// TRADE MONITOR サービスワーカー
// Android の Chrome で「アプリとしてインストール」できるようにするためのもの。
// 何もキャッシュせず、そのまま通信する（常に最新版のアプリと最新のデータを使うため）。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* ブラウザの通常の通信に任せる */ });
