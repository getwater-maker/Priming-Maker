'use strict';

/**
 * ImageManager — 이미지 생성 provider 추상화
 *
 * 현재 지원:
 *   - gemini : Nano Banana 2 (Gemini API 직접 호출, GPU 불필요)
 *   (Flow 브라우저 자동화는 flow-engine 경로로 별도 처리)
 *
 * 사용:
 *   const { getInstance } = require('./image/image-manager');
 *   const mgr = getInstance();
 *   await mgr.start();
 *   const result = await mgr.synth({
 *     prompt: 'a korean palace',
 *     outputPath: 'D:/.../images/01.png',
 *     onProgress: p => console.log(p)
 *   });
 *
 * TTSManager 패턴 그대로 복제. provider 등록은 start() 에서 일괄 처리.
 */

'use strict';

class ImageManager {
    constructor(opts = {}) {
        this.opts = opts;
        this.providers = new Map();
        this.logger = typeof opts.logger === 'function' ? opts.logger : () => {};
        this._started = false;
    }

    /** provider 초기화. Idempotent — 여러 번 호출해도 한 번만 실행. */
    async start() {
        if (this._started) return;
        this._started = true;

        // Gemini (Nano Banana 2) — GPU Pod 불필요, API 직접 호출
        try {
            const { GeminiImageProvider } = require('./providers/gemini-image-provider');
            const g = new GeminiImageProvider();
            await g.init();
            // 키가 없어도 등록은 해둔다 (synth 호출 시 키 안내). ready 는 키 유무 반영.
            this.providers.set('gemini', g);
            this.logger(`[Image] Gemini provider 등록 (키 ${g.hasKey ? '있음' : '없음'})`);
        } catch (e) {
            this.logger(`[Image] Gemini provider 로드 예외: ${e.message}`);
        }
    }

    async stop() {
        for (const p of this.providers.values()) {
            if (typeof p.stop === 'function') {
                try { await p.stop(); } catch {}
            }
        }
        this.providers.clear();
        this._started = false;
    }

    isAvailable(id = 'gemini') {
        const p = this.providers.get(id);
        return !!(p && p.ready);
    }

    getProvider(id = 'gemini') {
        return this.providers.get(id) || null;
    }

    listAvailable() {
        return Array.from(this.providers.entries())
            .filter(([, p]) => p.ready)
            .map(([id, p]) => ({ id, label: p.label || id }));
    }

    /**
     * 이미지 1장 생성.
     * @param {object} opts - provider.synth 인터페이스
     *   - prompt, outputPath, aspectRatio, onProgress
     *   - provider: 'gemini' (기본 · Nano Banana 2)
     */
    async synth(opts = {}) {
        if (!this._started) await this.start();
        const id = opts.provider || 'gemini';
        const p = this.providers.get(id);
        if (!p || !p.ready) {
            throw new Error(`이미지 provider '${id}' 비활성 — 시크릿/설정 확인`);
        }
        return await p.synth(opts);
    }
}

// 모듈 레벨 싱글톤
let _instance = null;
function getInstance(opts) {
    if (!_instance) {
        _instance = new ImageManager(opts);
    } else if (opts && opts.logger && typeof opts.logger === 'function') {
        _instance.logger = opts.logger;
    }
    return _instance;
}

module.exports = { ImageManager, getInstance };
