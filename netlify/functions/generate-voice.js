// File: netlify/functions/generate-voice.js
// Serverless proxy for ZEDCraft Studio -> Google Gemini 3.8 Flash TTS
// Keeps the owner's GEMINI_API_KEY private on the server so visitors never need to create API keys.

const ALLOWED_MODELS = new Set([
    'gemini-3.8-flash-tts',
    'gemini-3.8-flash-lite-tts'
]);

const ALLOWED_VOICES = new Set([
    'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
    'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
    'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
    'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
    'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'
]);

const MAX_SCRIPT_CHARS = 5000;

// Lightweight in-memory burst rate limiter per warm Lambda instance
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_REQUESTS = 15;
const ipHits = new Map();

function isRateLimited(ip) {
    const now = Date.now();
    const record = ipHits.get(ip);
    if (!record || now - record.start > RATE_WINDOW_MS) {
        ipHits.set(ip, { start: now, count: 1 });
        return false;
    }
    record.count += 1;
    return record.count > RATE_MAX_REQUESTS;
}

function getCorsHeaders() {
    const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
    return {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    };
}

/**
 * Parse a multi-speaker script ("Alex: ...\nMaya: ...") into separate Gemini 3.8 parts
 * with structured speechMetadata so speaker names are never spoken aloud.
 */
function parseDialogueParts(script, style) {
    const lines = script
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const turns = [];
    let currentSpeaker = 'Alex';

    for (const line of lines) {
        const match = line.match(/^(Alex|Maya)\s*:\s*(.+)$/i);
        if (match) {
            currentSpeaker = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
            const spokenText = match[2].trim();
            if (spokenText) {
                turns.push({ speaker: currentSpeaker, text: spokenText });
            }
        } else if (turns.length > 0) {
            turns[turns.length - 1].text += ' ' + line;
        } else {
            turns.push({ speaker: currentSpeaker, text: line });
        }
    }

    if (turns.length === 0) {
        turns.push({ speaker: 'Alex', text: script.trim() });
    }

    return turns.map((turn) => {
        const speechMetadata = { speaker: turn.speaker };
        if (style) speechMetadata.style = style;
        return {
            text: turn.text,
            speechMetadata
        };
    });
}

/**
 * Wrap raw 16-bit mono PCM in a standard 44-byte RIFF/WAV header if Gemini returns raw PCM.
 */
function ensureWavBuffer(buffer, mimeType = '') {
    // Already a valid RIFF/WAV file (Gemini 3.8 unary requests return complete WAV by default)
    if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'RIFF') {
        return buffer;
    }

    const rateMatch = mimeType ? mimeType.match(/rate=(\d+)/) : null;
    const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
    const dataSize = buffer.length;
    const header = Buffer.alloc(44);

    header.write('RIFF', 0, 4, 'ascii');
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8, 4, 'ascii');
    header.write('fmt ', 12, 4, 'ascii');
    header.writeUInt32LE(16, 16);        // PCM chunk size
    header.writeUInt16LE(1, 20);         // Audio format: PCM
    header.writeUInt16LE(1, 22);         // Channels: mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28); // Byte rate (16-bit mono)
    header.writeUInt16LE(2, 32);         // Block align
    header.writeUInt16LE(16, 34);        // Bits per sample
    header.write('data', 36, 4, 'ascii');
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, buffer]);
}

exports.handler = async (event) => {
    const headers = getCorsHeaders();

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers, body: '' };
    }

    // Health check endpoint so the frontend knows the built-in studio server is live
    if (event.httpMethod === 'GET') {
        return {
            statusCode: 200,
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ok: true,
                configured: Boolean(process.env.GEMINI_API_KEY),
                model: 'gemini-3.8-flash-tts'
            })
        };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        const clientIp =
            event.headers['x-nf-client-connection-ip'] ||
            (event.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
            'unknown';

        if (isRateLimited(clientIp)) {
            return {
                statusCode: 429,
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Too many voice generations in a minute. Please wait a few seconds and try again.' })
            };
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.error('Server misconfiguration: GEMINI_API_KEY is missing.');
            return {
                statusCode: 503,
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    error: 'Studio voice server is deployed, but GEMINI_API_KEY is not set in Netlify Environment Variables yet.'
                })
            };
        }

        let body;
        try {
            body = JSON.parse(event.body || '{}');
        } catch {
            return {
                statusCode: 400,
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Invalid JSON request body.' })
            };
        }

        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) {
            return {
                statusCode: 400,
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Please enter a script before generating audio.' })
            };
        }
        if (text.length > MAX_SCRIPT_CHARS) {
            return {
                statusCode: 400,
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: `Script is too long (max ${MAX_SCRIPT_CHARS} characters).` })
            };
        }

        const mode = body.mode === 'dialogue' ? 'dialogue' : 'single';
        const model = ALLOWED_MODELS.has(body.model) ? body.model : 'gemini-3.8-flash-tts';
        const style = typeof body.style === 'string' ? body.style.trim().slice(0, 200) : '';
        const voice = ALLOWED_VOICES.has(body.voice) ? body.voice : 'Zephyr';
        const speaker1 = ALLOWED_VOICES.has(body.speaker1) ? body.speaker1 : 'Fenrir';
        const speaker2 = ALLOWED_VOICES.has(body.speaker2) ? body.speaker2 : 'Aoede';

        // Build Gemini 3.8 Flash TTS GenerateContent payload
        // Note: Gemini 3.8 treats `text` as a verbatim transcript; delivery instructions go in `speechMetadata.style`.
        let parts;
        let speechConfig;

        if (mode === 'dialogue') {
            parts = parseDialogueParts(text, style);
            speechConfig = {
                multiSpeakerVoiceConfig: {
                    speakerVoiceConfigs: [
                        { speaker: 'Alex', voiceConfig: { prebuiltVoiceConfig: { voiceName: speaker1 } } },
                        { speaker: 'Maya', voiceConfig: { prebuiltVoiceConfig: { voiceName: speaker2 } } }
                    ]
                }
            };
        } else {
            const singlePart = { text };
            if (style) {
                singlePart.speechMetadata = { style };
            }
            parts = [singlePart];
            speechConfig = {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: voice }
                }
            };
        }

        const payload = {
            contents: [{ role: 'user', parts }],
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig
            }
        };

        const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
        const googleResponse = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify(payload)
        });

        if (!googleResponse.ok) {
            let upstreamMsg = `Upstream Gemini API error (${googleResponse.status})`;
            try {
                const errJson = await googleResponse.json();
                upstreamMsg = errJson?.error?.message || upstreamMsg;
            } catch {
                // ignore JSON parse failure
            }
            console.error('Upstream Gemini API Error:', googleResponse.status, upstreamMsg);
            return {
                statusCode: googleResponse.status === 429 ? 429 : 502,
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    error: googleResponse.status === 429
                        ? 'Google AI Studio free quota is temporarily busy. Please try again in a few seconds.'
                        : upstreamMsg
                })
            };
        }

        const result = await googleResponse.json();
        const inlineData = result?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
        const base64Audio = inlineData?.data;
        const mimeType = inlineData?.mimeType || '';

        if (!base64Audio) {
            console.error('No audio data returned:', JSON.stringify(result).slice(0, 500));
            return {
                statusCode: 502,
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'No audio data returned from Gemini 3.8 Flash TTS.' })
            };
        }

        const rawBuffer = Buffer.from(base64Audio, 'base64');
        const wavBuffer = ensureWavBuffer(rawBuffer, mimeType);

        return {
            statusCode: 200,
            headers: {
                ...headers,
                'Content-Type': 'audio/wav',
                'Cache-Control': 'no-store'
            },
            body: wavBuffer.toString('base64'),
            isBase64Encoded: true
        };
    } catch (error) {
        console.error('Proxy execution error:', error);
        return {
            statusCode: 500,
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Internal voice server error. Please try again.' })
        };
    }
};
