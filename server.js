// Minimal web server for ElevenLabs Conversational AI browser demo
// Reads ONLY from config.secrets.env (never from process environment)

const express = require('express');
const fs = require('fs');
const path = require('path');

// --- Config loader (reads config.secrets.env only) ---
function parseDotEnvFile(filePath) {
	const config = {};
	try {
		const raw = fs.readFileSync(filePath, 'utf8');
		for (const line of raw.split(/\r?\n/)) {
			if (!line || line.trim().startsWith('#')) continue;
			const idx = line.indexOf('=');
			if (idx === -1) continue;
			const key = line.slice(0, idx).trim();
			const val = line.slice(idx + 1).trim();
			if (key.length > 0) config[key] = val;
		}
	} catch (err) {
		console.error(`Failed to read ${filePath}: ${err.message}`);
	}
	return config;
}

function buildConfig() {
	const envPath = path.resolve(__dirname, 'config.secrets.env');
	const env = parseDotEnvFile(envPath);

	const cfg = {
		// Secrets (never expose to browser)
		elevenlabsApiKey: env.ELEVENLABS_API_KEY || env.XI_API_KEY || '',
		elevenlabsAgentId: env.ELEVENLABS_AGENT_ID || env.AGENT_ID || '',

		// Audio/stream settings (safe to expose)
		outputSampleRate: Number(env.OUTPUT_SAMPLE_RATE || 16000),
		audioChunkSizeMs: Number(env.AUDIO_CHUNK_SIZE_MS || 100),
		audioBufferMaxSize: Number(env.AUDIO_BUFFER_MAX_SIZE || 8000),
		audioMinChunkSize: Number(env.AUDIO_MIN_CHUNK_SIZE || 1600),
		elevenlabsResponseTimeout: Number(env.ELEVENLABS_RESPONSE_TIMEOUT || 200),

		// Server
		port: Number(env.PORT || 3000),
	};

	if (!cfg.elevenlabsApiKey || !cfg.elevenlabsAgentId) {
		console.warn('Missing ELEVENLABS_API_KEY and/or ELEVENLABS_AGENT_ID in config.secrets.env');
	}

	return cfg;
}

const config = buildConfig();

// --- Server ---
const app = express();

// Static SPA
app.use(express.static(path.join(__dirname, 'public')));

// Basic health endpoint
app.get('/healthz', (req, res) => {
	res.json({ ok: true });
});

// Expose non-secret config to client
app.get('/api/config', (req, res) => {
	res.json({
		outputSampleRate: config.outputSampleRate,
		audioChunkSizeMs: config.audioChunkSizeMs,
		audioBufferMaxSize: config.audioBufferMaxSize,
		audioMinChunkSize: config.audioMinChunkSize,
		elevenlabsResponseTimeout: config.elevenlabsResponseTimeout,
	});
});

// Get ElevenLabs signed URL (server-side uses API key so browser never sees it)
app.post('/api/get-signed-url', async (req, res) => {
	try {
		if (!config.elevenlabsApiKey || !config.elevenlabsAgentId) {
			return res.status(400).json({ error: 'Server is missing ElevenLabs credentials. Update config.secrets.env.' });
		}

		const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(config.elevenlabsAgentId)}`;
		const response = await fetch(url, {
			method: 'GET',
			headers: {
				'xi-api-key': config.elevenlabsApiKey,
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			const text = await response.text();
			return res.status(response.status).json({ error: 'Failed to get signed URL', details: text });
		}

		const data = await response.json();
		return res.json({ signed_url: data.signed_url });
	} catch (err) {
		console.error('Error fetching signed URL:', err);
		return res.status(500).json({ error: 'Internal server error' });
	}
});

// Fallback to SPA
app.get('*', (req, res) => {
	res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(config.port, () => {
	console.log(`Server listening on http://localhost:${config.port}`);
	console.log(`Serving SPA from ${path.join(__dirname, 'public')}`);
});


