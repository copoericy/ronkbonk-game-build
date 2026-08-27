/**
 * RonkBonk content safety — all-ages image uploads.
 * Blocks malware/polyglot files and rejects likely 18+ skin-heavy images.
 * Offline-safe: no network calls.
 */
(function (global) {
    'use strict';

    const MAX_BYTES = 4 * 1024 * 1024; // 4 MB
    const MAX_DATA_URL_CHARS = 900000;
    const OUTPUT_SIZE = 128;
    const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
    const ALLOWED_EXT = new Set(['jpg', 'jpeg', 'png', 'webp']);

    // Magic signatures (first bytes)
    const SIG = {
        jpeg: [0xff, 0xd8, 0xff],
        png: [0x89, 0x50, 0x4e, 0x47],
        webpRiff: [0x52, 0x49, 0x46, 0x46], // RIFF....WEBP
        webpMarker: [0x57, 0x45, 0x42, 0x50]
    };

    // Suspicious payloads often embedded in renamed "images"
    const DANGER_TEXT = [
        '<script', '</script', 'javascript:', '<?php', '<%',
        'eval(', 'Function(', 'fromCharCode', '<iframe',
        'application/x-msdownload', 'MZ', '%PDF'
    ];

    function reason(code, message) {
        return { ok: false, code, message };
    }

    function ok(payload) {
        return { ok: true, ...payload };
    }

    function extOf(name) {
        const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
        return m ? m[1] : '';
    }

    function bytesMatch(buf, offset, sig) {
        if (!buf || buf.length < offset + sig.length) return false;
        for (let i = 0; i < sig.length; i++) {
            if (buf[offset + i] !== sig[i]) return false;
        }
        return true;
    }

    function detectImageKind(buf) {
        if (bytesMatch(buf, 0, SIG.jpeg)) return 'jpeg';
        if (bytesMatch(buf, 0, SIG.png)) return 'png';
        if (bytesMatch(buf, 0, SIG.webpRiff) && bytesMatch(buf, 8, SIG.webpMarker)) return 'webp';
        return null;
    }

    function scanDangerText(buf) {
        // Sample head + mid + tail as latin1 text for polyglot/malware markers
        const slices = [];
        const len = buf.length;
        const take = (start, n) => {
            const end = Math.min(len, start + n);
            let s = '';
            for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]);
            return s.toLowerCase();
        };
        slices.push(take(0, Math.min(4096, len)));
        if (len > 8192) slices.push(take(Math.floor(len / 2) - 1024, 2048));
        if (len > 2048) slices.push(take(Math.max(0, len - 2048), 2048));
        const blob = slices.join('\n');
        // JPEG SOI alone is fine; "MZ" only counts at file start (Windows PE)
        if (bytesMatch(buf, 0, [0x4d, 0x5a])) return 'PE_EXECUTABLE';
        for (const token of DANGER_TEXT) {
            if (token === 'MZ') continue;
            if (blob.includes(token.toLowerCase())) return 'EMBEDDED_' + token.replace(/[^a-z0-9]+/gi, '_').toUpperCase();
        }
        return null;
    }

    function isSkinTone(r, g, b) {
        // YCbCr skin detection (common offline heuristic)
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        const cbOk = cb >= 77 && cb <= 127;
        const crOk = cr >= 133 && cr <= 173;
        const yOk = y > 40 && y < 240;
        // Also catch pinkish/peach RGB clusters
        const rgbSkin = r > 95 && g > 40 && b > 20
            && Math.max(r, g, b) - Math.min(r, g, b) > 15
            && Math.abs(r - g) > 15
            && r > g && r > b;
        return (cbOk && crOk && yOk) || rgbSkin;
    }

    function analyzeAgeSafety(imageData) {
        const { data, width, height } = imageData;
        if (!width || !height || !data || data.length < 16) {
            return { safe: false, reason: 'INVALID_PIXELS' };
        }

        let total = 0;
        let skin = 0;
        let centerSkin = 0;
        let centerTotal = 0;
        let dark = 0;
        let bright = 0;
        let edgeContrast = 0;

        const cx0 = Math.floor(width * 0.25);
        const cx1 = Math.floor(width * 0.75);
        const cy0 = Math.floor(height * 0.2);
        const cy1 = Math.floor(height * 0.85);

        // Sample every 2nd pixel for speed
        for (let y = 0; y < height; y += 2) {
            for (let x = 0; x < width; x += 2) {
                const i = (y * width + x) * 4;
                const r = data[i];
                const g = data[i + 1];
                const b = data[i + 2];
                const a = data[i + 3];
                if (a < 40) continue;
                total++;
                const lum = (r + g + b) / 3;
                if (lum < 35) dark++;
                if (lum > 220) bright++;
                const skinHit = isSkinTone(r, g, b);
                if (skinHit) skin++;
                const inCenter = x >= cx0 && x <= cx1 && y >= cy0 && y <= cy1;
                if (inCenter) {
                    centerTotal++;
                    if (skinHit) centerSkin++;
                }
                // crude edge energy
                if (x + 2 < width) {
                    const j = (y * width + (x + 2)) * 4;
                    edgeContrast += Math.abs(r - data[j]) + Math.abs(g - data[j + 1]) + Math.abs(b - data[j + 2]);
                }
            }
        }

        if (total < 80) return { safe: false, reason: 'TOO_SMALL' };

        const skinRatio = skin / total;
        const centerSkinRatio = centerTotal ? (centerSkin / centerTotal) : 0;
        const avgEdge = edgeContrast / Math.max(1, total);
        const darkRatio = dark / total;

        // High skin + center-heavy + low detail often indicates adult content.
        // Tuned to be strict for all-ages Steam storefront.
        const adultLike =
            (skinRatio >= 0.38 && centerSkinRatio >= 0.45 && avgEdge < 55) ||
            (skinRatio >= 0.48 && centerSkinRatio >= 0.4) ||
            (skinRatio >= 0.55) ||
            (centerSkinRatio >= 0.62 && skinRatio >= 0.32 && darkRatio < 0.55);

        if (adultLike) {
            return {
                safe: false,
                reason: 'AGE_RESTRICTED',
                metrics: { skinRatio, centerSkinRatio, avgEdge, darkRatio }
            };
        }
        return {
            safe: true,
            metrics: { skinRatio, centerSkinRatio, avgEdge, darkRatio }
        };
    }

    function canvasFromImageSource(source, size) {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('NO_CANVAS');
        // White fill strips alpha tricks / weird overlays
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(source, 0, 0, size, size);
        return { canvas, ctx };
    }

    function loadImageFromBlob(blob) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                resolve(img);
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('DECODE_FAIL'));
            };
            img.src = url;
        });
    }

    function loadImageFromDataUrl(dataUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('DECODE_FAIL'));
            img.src = dataUrl;
        });
    }

    async function readFileAsArrayBuffer(file) {
        if (file.arrayBuffer) return file.arrayBuffer();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('READ_FAIL'));
            reader.readAsArrayBuffer(file);
        });
    }

    /**
     * Validate + sanitize a local File from the upload picker.
     * Returns a clean JPEG data URL canvas-safe for the game.
     */
    async function sanitizeUploadFile(file) {
        if (!file) return reason('NO_FILE', 'No file selected.');
        if (file.size <= 0) return reason('EMPTY', 'File is empty.');
        if (file.size > MAX_BYTES) {
            return reason('TOO_LARGE', 'Image too large. Max 4 MB.');
        }

        const mime = String(file.type || '').toLowerCase();
        const ext = extOf(file.name);
        if (mime && !ALLOWED_MIME.has(mime)) {
            return reason('BAD_TYPE', 'Only JPG, PNG, or WEBP images are allowed.');
        }
        if (ext && !ALLOWED_EXT.has(ext)) {
            return reason('BAD_EXT', 'Only .jpg, .png, or .webp files are allowed.');
        }
        // Explicitly reject SVG / GIF / executable renames
        if (mime.includes('svg') || ext === 'svg' || ext === 'gif' || ext === 'html' || ext === 'js' || ext === 'exe') {
            return reason('FORBIDDEN_FORMAT', 'That file type is not allowed.');
        }

        let buf;
        try {
            buf = new Uint8Array(await readFileAsArrayBuffer(file));
        } catch (_) {
            return reason('READ_FAIL', 'Could not read that file.');
        }

        const kind = detectImageKind(buf);
        if (!kind) {
            return reason('BAD_SIGNATURE', 'File is not a real image (blocked for safety).');
        }

        const danger = scanDangerText(buf);
        if (danger) {
            return reason('MALWARE_PATTERN', 'Unsafe content detected in file. Upload blocked.');
        }

        let img;
        try {
            // Rebuild blob with correct MIME so decoder can't be tricked by extension
            const safeMime = kind === 'png' ? 'image/png' : (kind === 'webp' ? 'image/webp' : 'image/jpeg');
            const blob = new Blob([buf], { type: safeMime });
            img = await loadImageFromBlob(blob);
        } catch (_) {
            return reason('DECODE_FAIL', 'Could not decode image. Try another JPG/PNG.');
        }

        if ((img.naturalWidth || img.width) < 8 || (img.naturalHeight || img.height) < 8) {
            return reason('TOO_SMALL', 'Image is too small.');
        }
        if ((img.naturalWidth || img.width) > 8192 || (img.naturalHeight || img.height) > 8192) {
            return reason('DIMENSIONS', 'Image dimensions too large.');
        }

        let canvas, ctx;
        try {
            ({ canvas, ctx } = canvasFromImageSource(img, OUTPUT_SIZE));
        } catch (_) {
            return reason('CANVAS_FAIL', 'Could not process image.');
        }

        let pixels;
        try {
            pixels = ctx.getImageData(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
        } catch (_) {
            return reason('PIXEL_FAIL', 'Could not inspect image pixels.');
        }

        const age = analyzeAgeSafety(pixels);
        if (!age.safe) {
            if (age.reason === 'AGE_RESTRICTED') {
                return reason(
                    'AGE_RESTRICTED',
                    'This image looks like it may be 18+ / inappropriate. RonkBonk is all-ages — please choose a different picture.'
                );
            }
            return reason(age.reason, 'Image failed safety checks.');
        }

        // Re-encode as JPEG — strips EXIF, scripts, polyglots, animated frames
        let dataUrl;
        try {
            dataUrl = canvas.toDataURL('image/jpeg', 0.72);
        } catch (_) {
            return reason('ENCODE_FAIL', 'Could not save sanitized image.');
        }
        if (!dataUrl || !dataUrl.startsWith('data:image/jpeg')) {
            return reason('ENCODE_FAIL', 'Sanitized image invalid.');
        }
        if (dataUrl.length > MAX_DATA_URL_CHARS) {
            return reason('TOO_LARGE', 'Processed image still too large.');
        }

        return ok({ dataUrl, canvas, kind });
    }

    /**
     * Validate a data URL from localStorage or online peer.
     * Only JPEG/PNG data URLs accepted; always re-sanitized through canvas.
     */
    async function sanitizeDataUrl(dataUrl) {
        if (!dataUrl || typeof dataUrl !== 'string') {
            return reason('NO_DATA', 'No image data.');
        }
        if (dataUrl.length > MAX_DATA_URL_CHARS) {
            return reason('TOO_LARGE', 'Image data too large.');
        }
        // Block SVG data URLs and anything not jpeg/png/webp
        const m = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
        if (!m) return reason('BAD_DATA_URL', 'Invalid image data.');
        const mime = m[1].toLowerCase();
        if (!ALLOWED_MIME.has(mime) || mime.includes('svg')) {
            return reason('BAD_TYPE', 'Only JPG/PNG/WEBP image data allowed.');
        }
        // Reject obvious script payloads in the string itself
        const lower = dataUrl.slice(0, 200).toLowerCase() + dataUrl.slice(-200).toLowerCase();
        if (lower.includes('<script') || lower.includes('javascript:')) {
            return reason('MALWARE_PATTERN', 'Unsafe image data blocked.');
        }

        let img;
        try {
            img = await loadImageFromDataUrl(dataUrl);
        } catch (_) {
            return reason('DECODE_FAIL', 'Could not decode shared image.');
        }

        let canvas, ctx;
        try {
            ({ canvas, ctx } = canvasFromImageSource(img, OUTPUT_SIZE));
        } catch (_) {
            return reason('CANVAS_FAIL', 'Could not process shared image.');
        }

        let pixels;
        try {
            pixels = ctx.getImageData(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
        } catch (_) {
            return reason('SHARED_PIXEL', 'Could not inspect shared image.');
        }

        const age = analyzeAgeSafety(pixels);
        if (!age.safe) {
            return reason(
                age.reason === 'AGE_RESTRICTED' ? 'SHARED_AGE' : 'SHARED_FAIL',
                age.reason === 'AGE_RESTRICTED'
                    ? 'Shared image blocked — may be inappropriate for all ages.'
                    : 'Shared image failed safety checks.'
            );
        }

        let clean;
        try {
            clean = canvas.toDataURL('image/jpeg', 0.72);
        } catch (_) {
            return reason('SHARED_ENCODE', 'Could not sanitize shared image.');
        }
        return ok({ dataUrl: clean, canvas });
    }

    function userMessage(result) {
        if (!result || result.ok) return '';
        return result.message || 'Upload blocked by content safety.';
    }

    global.RonkContentSafety = {
        MAX_BYTES,
        sanitizeUploadFile,
        sanitizeDataUrl,
        analyzeAgeSafety,
        userMessage
    };
})(typeof window !== 'undefined' ? window : globalThis);
