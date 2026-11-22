// File: netlify/functions/generate-voice.js

exports.handler = async (event, context) => {
    // 1. Enforce CORS for local emulation and production security
    const headers = {
        'Access-Control-Allow-Origin': '*', // In production, restrict to 'https://khalil4ever.github.io'
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    // Handle preflight CORS requests immediately
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: 'Method Not Allowed' };
    }

    try {
        // 2. Parse the sanitized input from the frontend payload
        const { text, voice, style, mode, speaker1, speaker2 } = JSON.parse(event.body);

        if (!text) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing transcript text" }) };
        }

        // 3. Retrieve the secure API Key from the server environment variables
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.error("Server misconfiguration: GEMINI_API_KEY is missing.");
            return { statusCode: 500, headers, body: JSON.stringify({ error: "Server Configuration Error" }) };
        }

        // 4. Construct the Gemini 3.8 API target URL (v1beta is required for TTS)
        const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent?key=${apiKey}`;
        
        // 5. Build the baseline Payload
        let payload = {
            contents: [{
                parts: [{
                    text: text,
                    // Apply emotional styling via structured metadata (prevents reading aloud)
                    annotations: style && style !== 'natural' ? [{
                        type: "speech_metadata",
                        style: style
                    }] : []
                }]
            }],
            generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {}
            }
        };

        // 6. Inject either Single Voice or Multi-Speaker configuration
        if (mode === 'dialogue' && speaker1 && speaker2) {
            payload.generationConfig.speechConfig = {
                multiSpeakerVoiceConfig: {
                    speakerVoiceConfigs: [
                        { speaker: "Alex", voiceConfig: { prebuiltVoiceConfig: { voiceName: speaker1 } } },
                        { speaker: "Maya", voiceConfig: { prebuiltVoiceConfig: { voiceName: speaker2 } } }
                    ]
                }
            };
        } else {
            payload.generationConfig.speechConfig = {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: voice || "Zephyr" }
                }
            };
        }

        // 7. Execute the authenticated POST request to Google Gemini
        const googleResponse = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!googleResponse.ok) {
            const errorData = await googleResponse.text();
            console.error("Upstream Gemini API Error:", googleResponse.status, errorData);
            return { statusCode: googleResponse.status, headers, body: JSON.stringify({ error: "Upstream API failure" }) };
        }

        const result = await googleResponse.json();
        
        // 8. Extract the Base64 audio string from the JSON response
        const base64Audio = result?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

        if (!base64Audio) {
            throw new Error("No audio data returned from Gemini engine");
        }

        // 9. Convert Base64 directly to a binary Buffer
        // Gemini 3.8 natively returns a complete, headered WAV file on unary requests.
        const audioBuffer = Buffer.from(base64Audio, 'base64');

        // 10. Stream the binary Buffer back to the frontend with the correct MIME type
        return {
            statusCode: 200,
            headers: {
                ...headers,
                'Content-Type': 'audio/wav',
                'Content-Length': audioBuffer.length.toString()
            },
            body: audioBuffer.toString('base64'),
            isBase64Encoded: true
        };

    } catch (error) {
        console.error("Proxy execution error:", error);
        return { 
            statusCode: 500, 
            headers, 
            body: JSON.stringify({ error: "Internal Proxy Server Error" }) 
        };
    }
};
