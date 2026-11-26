# ZEDCraft Studio

AI Voiceover Studio powered by **Google Gemini 3.8 Flash TTS** (`gemini-3.8-flash-tts`) — built so visitors can generate studio-grade voiceovers and multi-speaker dialogues **without creating their own API keys**.

## How Keyless Voice Generation Works

A Netlify serverless function (`netlify/functions/generate-voice.js`, exposed at `/api/generate-voice`) holds your single free Google AI Studio API key safely on the server. Visitors just type a script, pick a voice, and click **Generate Voiceover**.

## Deploy in 3 Steps (Free on Netlify)

1. Go to [Netlify](https://app.netlify.com/) → **Add new site** → **Import an existing project** → select `khalil4ever/ZEDCraft-Studio`.
2. Leave the build settings as detected (`netlify.toml` configures everything automatically).
3. In **Site configuration → Environment variables**, add:
   - **Key**: `GEMINI_API_KEY`
   - **Value**: your free key from [Google AI Studio](https://aistudio.google.com/app/apikey)
4. Trigger a redeploy. Your site's status pill will turn green (**3.8 Flash Free**) and all users can generate voices immediately with zero API key setup.
