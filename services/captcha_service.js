const crypto = require("crypto");

const PUZZLE_WIDTH = 300;
const PUZZLE_HEIGHT = 150;
const PIECE_SIZE = 42;
const TAB_RADIUS = 8;
const PIECE_PAD = 10;
const PIECE_BOX = PIECE_SIZE + PIECE_PAD * 2; // 62
const MAX_OFFSET_X = PUZZLE_WIDTH - PIECE_SIZE; // 258
const MATCH_TOLERANCE_PX = 6;
const MIN_HUMAN_DURATION_MS = 120;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 3 * 60 * 1000;
const MAX_ATTEMPTS_PER_CHALLENGE = 3;
const MAX_STORED_CHALLENGES = 4000;

const RUNTIME_FALLBACK_SECRET = crypto.randomBytes(32).toString("hex");

function getHmacSecret() {
    return (
        process.env.CAPTCHA_SECRET ||
        process.env.CUSTOMER_SESSION_SECRET ||
        RUNTIME_FALLBACK_SECRET
    );
}

const SCENE_THEMES = [
    {
        name: "Bình minh Vịnh Hạ Long",
        skyStart: "#38BDF8",
        skyMid: "#A5F3FC",
        skyEnd: "#FDE68A",
        hillBack: "#0F766E",
        hillMid: "#115E59",
        hillFront: "#134E4A",
        sun: "#FBBF24",
        accent: "#F472B6",
    },
    {
        name: "Chiều vàng Hội An",
        skyStart: "#F59E0B",
        skyMid: "#FDE68A",
        skyEnd: "#FEF3C7",
        hillBack: "#92400E",
        hillMid: "#78350F",
        hillFront: "#1E293B",
        sun: "#FEF08A",
        accent: "#FB7185",
    },
    {
        name: "Đà Lạt sương sớm",
        skyStart: "#6366F1",
        skyMid: "#A5B4FC",
        skyEnd: "#FBCFE8",
        hillBack: "#312E81",
        hillMid: "#1E1B4B",
        hillFront: "#0F172A",
        sun: "#FDE047",
        accent: "#38BDF8",
    },
    {
        name: "Phú Quốc biển xanh",
        skyStart: "#0284C7",
        skyMid: "#67E8F9",
        skyEnd: "#E0F2FE",
        hillBack: "#0369A1",
        hillMid: "#0E7490",
        hillFront: "#173B2B",
        sun: "#FACC15",
        accent: "#FDA4AF",
    },
    {
        name: "Tràng An non nước",
        skyStart: "#0D9488",
        skyMid: "#99F6E4",
        skyEnd: "#ECFDF5",
        hillBack: "#115E59",
        hillMid: "#14532D",
        hillFront: "#064E3B",
        sun: "#F5B82E",
        accent: "#60A5FA",
    },
];

// Lưu trữ in-memory phục vụ chống phát lại (single-use) và giới hạn số lần kéo sai
const challengeStore = new Map();
const rateLimitStore = new Map();

function pruneExpiredEntries(now = Date.now()) {
    for (const [id, entry] of challengeStore.entries()) {
        if (entry.expiresAt <= now || entry.consumed) {
            challengeStore.delete(id);
        }
    }
    if (challengeStore.size > MAX_STORED_CHALLENGES) {
        const overflow = challengeStore.size - MAX_STORED_CHALLENGES;
        let removed = 0;
        for (const id of challengeStore.keys()) {
            challengeStore.delete(id);
            removed += 1;
            if (removed >= overflow) break;
        }
    }
    for (const [key, bucket] of rateLimitStore.entries()) {
        if (bucket.resetAt <= now) {
            rateLimitStore.delete(key);
        }
    }
}

function normalizeClientKey(ip) {
    const raw = typeof ip === "string" ? ip.trim() : "";
    return raw || "unknown";
}

function checkRateLimit(bucketName, clientKey, { maxHits = 30, windowMs = 5 * 60 * 1000 } = {}) {
    const now = Date.now();
    const key = `${bucketName}:${normalizeClientKey(clientKey)}`;
    let bucket = rateLimitStore.get(key);

    if (!bucket || bucket.resetAt <= now) {
        bucket = { hits: 0, resetAt: now + windowMs };
        rateLimitStore.set(key, bucket);
    }

    bucket.hits += 1;
    if (bucket.hits > maxHits) {
        return {
            allowed: false,
            retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
        };
    }

    return {
        allowed: true,
        remaining: Math.max(0, maxHits - bucket.hits),
    };
}

function buildJigsawPath(x, y, size = PIECE_SIZE, r = TAB_RADIUS, variant = 0) {
    const x1 = x + size * 0.36;
    const x2 = x + size * 0.64;
    const xm = x + size * 0.5;
    const y1 = y + size * 0.36;
    const y2 = y + size * 0.64;
    const ym = y + size * 0.5;
    const xr = x + size;
    const yb = y + size;

    const topDir = variant % 2 === 0 ? -1 : -0.9;
    const rightDir = variant === 1 ? -0.75 : 1;
    const leftIn = variant === 2 ? 0.72 : 0.82;

    return [
        `M ${x} ${y}`,
        `L ${x1} ${y}`,
        `C ${x1 - 2} ${y + topDir * r * 0.35}, ${x + size * 0.3} ${y + topDir * r}, ${xm} ${y + topDir * r}`,
        `C ${x + size * 0.7} ${y + topDir * r}, ${x2 + 2} ${y + topDir * r * 0.35}, ${x2} ${y}`,
        `L ${xr} ${y}`,
        `L ${xr} ${y1}`,
        `C ${xr + rightDir * r * 0.35} ${y1 - 2}, ${xr + rightDir * r} ${y + size * 0.3}, ${xr + rightDir * r} ${ym}`,
        `C ${xr + rightDir * r} ${y + size * 0.7}, ${xr + rightDir * r * 0.35} ${y2 + 2}, ${xr} ${y2}`,
        `L ${xr} ${yb}`,
        `L ${x} ${yb}`,
        `L ${x} ${y2}`,
        `C ${x + leftIn * r * 0.35} ${y2 + 1}, ${x + leftIn * r} ${y + size * 0.68}, ${x + leftIn * r} ${ym}`,
        `C ${x + leftIn * r} ${y + size * 0.32}, ${x + leftIn * r * 0.35} ${y1 - 1}, ${x} ${y1}`,
        "Z",
    ].join(" ");
}

function buildSceneContent(theme, seed, challengeId) {
    const gradId = `bg_${challengeId.slice(0, 8)}`;
    const sunX = 48 + (seed % 145);
    const sunY = 28 + ((seed >> 3) % 34);
    const peak1 = 56 + ((seed >> 2) % 32);
    const peak2 = 66 + ((seed >> 4) % 28);
    const bubbleX = 180 + (seed % 90);
    const bubbleY = 30 + ((seed >> 5) % 45);

    return `
      <defs>
        <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${theme.skyStart}" />
          <stop offset="52%" stop-color="${theme.skyMid}" />
          <stop offset="100%" stop-color="${theme.skyEnd}" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${PUZZLE_WIDTH}" height="${PUZZLE_HEIGHT}" fill="url(#${gradId})" />
      <circle cx="${sunX}" cy="${sunY}" r="18" fill="${theme.sun}" fill-opacity="0.88" />
      <circle cx="${bubbleX}" cy="${bubbleY}" r="36" fill="${theme.accent}" fill-opacity="0.26" />
      <circle cx="${bubbleX - 42}" cy="${bubbleY + 24}" r="22" fill="#FFFFFF" fill-opacity="0.22" />
      <path d="M 0 112 Q 62 ${peak1}, 130 105 T 255 96 L ${PUZZLE_WIDTH} 110 L ${PUZZLE_WIDTH} ${PUZZLE_HEIGHT} L 0 ${PUZZLE_HEIGHT} Z" fill="${theme.hillBack}" fill-opacity="0.58" />
      <path d="M 0 124 Q 90 ${peak2}, 182 118 T ${PUZZLE_WIDTH} 112 L ${PUZZLE_WIDTH} ${PUZZLE_HEIGHT} L 0 ${PUZZLE_HEIGHT} Z" fill="${theme.hillMid}" fill-opacity="0.72" />
      <path d="M 0 135 Q 110 116, 210 132 T ${PUZZLE_WIDTH} 128 L ${PUZZLE_WIDTH} ${PUZZLE_HEIGHT} L 0 ${PUZZLE_HEIGHT} Z" fill="${theme.hillFront}" fill-opacity="0.85" />
      <g fill="#FFFFFF" fill-opacity="0.32">
        <rect x="${22 + (seed % 40)}" y="24" width="38" height="10" rx="5" />
        <rect x="${155 + (seed % 65)}" y="18" width="48" height="11" rx="5.5" />
        <rect x="44" y="64" width="18" height="18" rx="4" transform="rotate(14 53 73)" />
        <rect x="230" y="88" width="16" height="16" rx="4" transform="rotate(-12 238 96)" />
      </g>
    `.trim();
}

function toSvgDataUri(svgString) {
    return `data:image/svg+xml;base64,${Buffer.from(svgString, "utf8").toString("base64")}`;
}

function renderChallengeGraphics(challengeId, targetX, targetY, themeIndex, seed, variant) {
    const theme = SCENE_THEMES[themeIndex % SCENE_THEMES.length];
    const scene = buildSceneContent(theme, seed, challengeId);
    const slotPath = buildJigsawPath(targetX, targetY, PIECE_SIZE, TAB_RADIUS, variant);

    const backgroundSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${PUZZLE_WIDTH}" height="${PUZZLE_HEIGHT}" viewBox="0 0 ${PUZZLE_WIDTH} ${PUZZLE_HEIGHT}">
  ${scene}
  <path d="${slotPath}" fill="rgba(15, 23, 42, 0.54)" stroke="rgba(255, 255, 255, 0.72)" stroke-width="1.5" />
</svg>`.trim();

    const clipId = `clip_${challengeId.slice(0, 8)}`;
    const piecePath = buildJigsawPath(PIECE_PAD, PIECE_PAD, PIECE_SIZE, TAB_RADIUS, variant);
    const pieceSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${PIECE_BOX}" height="${PIECE_BOX}" viewBox="0 0 ${PIECE_BOX} ${PIECE_BOX}">
  <defs>
    <clipPath id="${clipId}">
      <path d="${piecePath}" />
    </clipPath>
  </defs>
  <g clip-path="url(#${clipId})">
    <g transform="translate(${-(targetX - PIECE_PAD)}, ${-(targetY - PIECE_PAD)})">
      ${scene}
    </g>
  </g>
  <path d="${piecePath}" fill="none" stroke="rgba(255, 255, 255, 0.96)" stroke-width="2" />
  <path d="${piecePath}" fill="none" stroke="rgba(15, 23, 42, 0.35)" stroke-width="0.75" />
</svg>`.trim();

    return {
        themeName: theme.name,
        backgroundUrl: toSvgDataUri(backgroundSvg),
        pieceUrl: toSvgDataUri(pieceSvg),
    };
}

function signTokenPayload(payload) {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const sig = crypto
        .createHmac("sha256", getHmacSecret())
        .update(encoded)
        .digest("base64url");
    return `${encoded}.${sig}`;
}

function verifyTokenSignature(token) {
    if (typeof token !== "string" || !token.includes(".")) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [encoded, providedSig] = parts;
    const expectedSig = crypto
        .createHmac("sha256", getHmacSecret())
        .update(encoded)
        .digest("base64url");

    const bufA = Buffer.from(providedSig, "utf8");
    const bufB = Buffer.from(expectedSig, "utf8");
    if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
        return null;
    }

    try {
        return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
        return null;
    }
}

function createChallenge(clientIp = "unknown") {
    pruneExpiredEntries();
    const challengeId = crypto.randomUUID();
    const targetX = crypto.randomInt(108, 238);
    const targetY = crypto.randomInt(22, 84);
    const themeIndex = crypto.randomInt(0, SCENE_THEMES.length);
    const seed = crypto.randomInt(10, 99999);
    const variant = crypto.randomInt(0, 3);
    const now = Date.now();
    const expiresAt = now + CHALLENGE_TTL_MS;

    challengeStore.set(challengeId, {
        id: challengeId,
        targetX,
        targetY,
        attempts: 0,
        verified: false,
        consumed: false,
        verificationNonce: null,
        ip: normalizeClientKey(clientIp),
        createdAt: now,
        expiresAt,
    });

    const graphics = renderChallengeGraphics(
        challengeId,
        targetX,
        targetY,
        themeIndex,
        seed,
        variant
    );

    return {
        challengeId,
        width: PUZZLE_WIDTH,
        height: PUZZLE_HEIGHT,
        pieceSize: PIECE_SIZE,
        pieceBoxSize: PIECE_BOX,
        piecePad: PIECE_PAD,
        maxOffsetX: MAX_OFFSET_X,
        y: targetY,
        themeName: graphics.themeName,
        backgroundUrl: graphics.backgroundUrl,
        pieceUrl: graphics.pieceUrl,
        expiresAt: new Date(expiresAt).toISOString(),
    };
}

function hasReasonableInteraction(durationMs, trail, mode) {
    if (!Number.isFinite(durationMs) || durationMs < MIN_HUMAN_DURATION_MS) {
        return false;
    }
    if (mode === "keyboard" || mode === "track_click") {
        return true;
    }
    if (Array.isArray(trail) && trail.length >= 2) {
        return true;
    }
    return false;
}

function verifyChallenge(body = {}, clientIp = "unknown") {
    pruneExpiredEntries();

    const challengeId = typeof body.challengeId === "string" ? body.challengeId.trim() : "";
    const offsetX = Number(body.offsetX);
    const durationMs = Number(body.durationMs);
    const mode = typeof body.mode === "string" ? body.mode.trim() : "pointer";
    const trail = body.trail;

    if (!challengeId || !Number.isFinite(offsetX)) {
        return {
            success: false,
            errorCode: "CAPTCHA_DATA_INVALID",
            message: "Dữ liệu xác thực captcha không hợp lệ.",
            shouldRefresh: true,
        };
    }

    const entry = challengeStore.get(challengeId);
    if (!entry) {
        return {
            success: false,
            errorCode: "CAPTCHA_EXPIRED",
            message: "Phiên captcha đã hết hạn. Vui lòng kéo mảnh ghép mới.",
            shouldRefresh: true,
        };
    }

    if (entry.consumed) {
        challengeStore.delete(challengeId);
        return {
            success: false,
            errorCode: "CAPTCHA_USED",
            message: "Mã captcha này đã được sử dụng. Vui lòng xác nhận lại.",
            shouldRefresh: true,
        };
    }

    if (entry.expiresAt <= Date.now()) {
        challengeStore.delete(challengeId);
        return {
            success: false,
            errorCode: "CAPTCHA_EXPIRED",
            message: "Captcha đã hết thời gian hiệu lực. Vui lòng kéo mảnh ghép mới.",
            shouldRefresh: true,
        };
    }

    entry.attempts += 1;

    if (!hasReasonableInteraction(durationMs, trail, mode)) {
        if (entry.attempts >= MAX_ATTEMPTS_PER_CHALLENGE) {
            challengeStore.delete(challengeId);
        }
        return {
            success: false,
            errorCode: "CAPTCHA_BOT_DETECTED",
            message: "Thao tác kéo chưa hợp lệ. Vui lòng kéo mượt mảnh ghép vào ô trống.",
            shouldRefresh: entry.attempts >= MAX_ATTEMPTS_PER_CHALLENGE,
        };
    }

    const delta = Math.abs(offsetX - entry.targetX);
    if (delta > MATCH_TOLERANCE_PX) {
        const exhaust = entry.attempts >= MAX_ATTEMPTS_PER_CHALLENGE;
        if (exhaust) {
            challengeStore.delete(challengeId);
        }
        return {
            success: false,
            errorCode: "CAPTCHA_MISMATCH",
            message: exhaust
                ? "Bạn đã kéo sai quá nhiều lần. Hệ thống vừa tạo hình xác nhận mới."
                : "Mảnh ghép chưa khớp đúng vị trí. Vui lòng kéo lại.",
            shouldRefresh: exhaust,
        };
    }

    const nonce = crypto.randomBytes(16).toString("hex");
    const tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
    entry.verified = true;
    entry.verificationNonce = nonce;
    entry.expiresAt = tokenExpiresAt;
    entry.ip = normalizeClientKey(clientIp);

    const captchaToken = signTokenPayload({
        cid: challengeId,
        nonce,
        exp: tokenExpiresAt,
    });

    return {
        success: true,
        captchaToken,
        expiresAt: new Date(tokenExpiresAt).toISOString(),
        message: "Xác thực captcha thành công.",
    };
}

function consumeVerifiedCaptcha(captchaToken) {
    pruneExpiredEntries();

    const parsed = verifyTokenSignature(captchaToken);
    if (!parsed || !parsed.cid || !parsed.nonce || !parsed.exp) {
        return {
            valid: false,
            errorCode: "CAPTCHA_INVALID",
            message: "Vui lòng kéo mảnh ghép vào đúng vị trí để xác nhận bảo mật.",
        };
    }

    if (Number(parsed.exp) <= Date.now()) {
        challengeStore.delete(parsed.cid);
        return {
            valid: false,
            errorCode: "CAPTCHA_EXPIRED",
            message: "Xác nhận captcha đã hết hạn. Vui lòng kéo lại mảnh ghép.",
        };
    }

    const entry = challengeStore.get(parsed.cid);
    if (!entry || !entry.verified || entry.consumed || entry.verificationNonce !== parsed.nonce) {
        return {
            valid: false,
            errorCode: "CAPTCHA_INVALID",
            message: "Mã captcha không hợp lệ hoặc đã được sử dụng. Vui lòng kéo lại.",
        };
    }

    // Tiêu thụ một lần duy nhất (atomic single-use) để chặn spam đăng nhập lặp lại token
    entry.consumed = true;
    challengeStore.delete(parsed.cid);

    return {
        valid: true,
        challengeId: parsed.cid,
    };
}

function _getTargetXForTest(challengeId) {
    return challengeStore.get(challengeId)?.targetX ?? null;
}

module.exports = {
    PUZZLE_WIDTH,
    PUZZLE_HEIGHT,
    PIECE_SIZE,
    PIECE_BOX,
    MAX_OFFSET_X,
    MATCH_TOLERANCE_PX,
    checkRateLimit,
    createChallenge,
    verifyChallenge,
    consumeVerifiedCaptcha,
    _getTargetXForTest,
};
