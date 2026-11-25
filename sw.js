// 以前の版で登録されたサービスワーカーを解除するためだけのファイル（現在は使っていない）
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => { self.registration.unregister(); });
