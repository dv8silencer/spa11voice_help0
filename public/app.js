(() => {
	const logEl = document.getElementById('log');
	function log(msg) {
		const t = new Date().toISOString();
		logEl.textContent += `[${t}] ${msg}\n`;
		logEl.scrollTop = logEl.scrollHeight;
	}

	const connectBtn = document.getElementById('connectBtn');
	const talkBtn = document.getElementById('talkBtn');
	const loopbackEl = document.getElementById('loopback');
	const aiAudio = document.getElementById('aiAudio');

	let cfg = null;
	let ws = null;
	let audioContext = null;
	let micStream = null;
	let sourceNode = null;
	let processorNode = null;
	let mediaStreamDest = null;
	let loopbackSource = null;
	let isTalking = false;
	let lastAudioSent = 0;
	let silenceTimer = null;

	let receivedAudioChunks = [];
	let playbackSource = null;
	let playQueue = [];
	let isPlaying = false;
	let elevenAudioSampleRate = null; // inferred from ElevenLabs audio_event.audio_format when available

	async function fetchConfig() {
		const res = await fetch('/api/config');
		if (!res.ok) throw new Error(`Config load failed: ${res.status}`);
		return await res.json();
	}

	async function getSignedUrl() {
		const res = await fetch('/api/get-signed-url', { method: 'POST' });
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`get-signed-url failed: ${res.status} ${text}`);
		}
		const data = await res.json();
		return data.signed_url;
	}

	function interleaveToPCM16(buffer, channels) {
		// Convert Float32Array (mono) to 16-bit PCM Little Endian
		const len = buffer.length;
		const out = new Int16Array(len);
		for (let i = 0; i < len; i++) {
			const s = Math.max(-1, Math.min(1, buffer[i]));
			out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
		}
		return out;
	}

	function concatUint8Arrays(chunks) {
		let total = 0;
		for (const c of chunks) total += c.length;
		const out = new Uint8Array(total);
		let offset = 0;
		for (const c of chunks) {
			out.set(c, offset);
			offset += c.length;
		}
		return out;
	}

	async function setupAudio() {
		if (!audioContext) {
			audioContext = new (window.AudioContext || window.webkitAudioContext)({
				sampleRate: cfg.outputSampleRate || 48000
			});
			log(`AudioContext created @ ${audioContext.sampleRate} Hz`);
		}

		micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
		sourceNode = audioContext.createMediaStreamSource(micStream);

		// ScriptProcessorNode is deprecated, but widely supported and simple for a demo
		const bufferSize = 2048; // Small-ish for latency, browser mixes to context sample rate
		processorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);


		function resampleIfNeeded(float32, fromRate, toRate) {
			if (fromRate === toRate) return float32;
			const ratio = toRate / fromRate;
			const newLen = Math.round(float32.length * ratio);
			const out = new Float32Array(newLen);
			for (let i = 0; i < newLen; i++) {
				const srcIndex = i / ratio;
				const i0 = Math.floor(srcIndex);
				const i1 = Math.min(i0 + 1, float32.length - 1);
				const frac = srcIndex - i0;
				out[i] = float32[i0] * (1 - frac) + float32[i1] * frac;
			}
			return out;
		}

		processorNode.onaudioprocess = (e) => {
			if (!ws || ws.readyState !== WebSocket.OPEN) return;
			let input = e.inputBuffer.getChannelData(0);
			// Resample to configured output rate if necessary
			const desiredRate = cfg.outputSampleRate || audioContext.sampleRate;
			if (audioContext.sampleRate !== desiredRate) {
				input = resampleIfNeeded(input, audioContext.sampleRate, desiredRate);
			}
			const pcm16 = interleaveToPCM16(input, 1);
			const b64 = btoa(String.fromCharCode.apply(null, new Uint8Array(pcm16.buffer)));
			if (isTalking) {
				ws.send(JSON.stringify({ type: 'user_audio_chunk', user_audio_chunk: b64 }));
				lastAudioSent = Date.now();
			}
		};

		sourceNode.connect(processorNode);
		processorNode.connect(audioContext.destination); // needed to keep processor running

		if (loopbackEl.checked) {
			mediaStreamDest = audioContext.createMediaStreamDestination();
			sourceNode.connect(mediaStreamDest);
			aiAudio.srcObject = mediaStreamDest.stream;
			loopbackSource = aiAudio;
		}
	}

	async function decodeToAudioBuffer(combinedBytes) {
		// Try compressed decode first (mp3/wav/ogg)
		try {
			const ab = combinedBytes.buffer.slice(combinedBytes.byteOffset, combinedBytes.byteOffset + combinedBytes.byteLength);
			const decoded = await audioContext.decodeAudioData(ab);
			return decoded;
		} catch (_) {
			// Fallback: treat as PCM16 mono at configured outputSampleRate
			const srcRate = elevenAudioSampleRate || cfg.outputSampleRate || audioContext.sampleRate;
			const pcm16 = new Int16Array(combinedBytes.buffer, combinedBytes.byteOffset, combinedBytes.byteLength / 2);
			const float32 = new Float32Array(pcm16.length);
			for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 0x8000;
			let outFloats = float32;
			if (audioContext.sampleRate !== srcRate) {
				outFloats = (function resample(from, fromRate, toRate) {
					const ratio = toRate / fromRate;
					const newLen = Math.round(from.length * ratio);
					const out = new Float32Array(newLen);
					for (let i = 0; i < newLen; i++) {
						const srcIndex = i / ratio;
						const i0 = Math.floor(srcIndex);
						const i1 = Math.min(i0 + 1, from.length - 1);
						const frac = srcIndex - i0;
						out[i] = from[i0] * (1 - frac) + from[i1] * frac;
					}
					return out;
				})(float32, srcRate, audioContext.sampleRate);
			}
			const buffer = audioContext.createBuffer(1, outFloats.length, audioContext.sampleRate);
			buffer.copyToChannel(outFloats, 0);
			return buffer;
		}
	}

	function enqueuePlayback(audioBuffer) {
		playQueue.push(audioBuffer);
		if (!isPlaying) {
			playNextInQueue();
		}
	}

	function playNextInQueue() {
		if (playQueue.length === 0) {
			isPlaying = false;
			playbackSource = null;
			return;
		}
		isPlaying = true;
		const nextBuffer = playQueue.shift();
		playbackSource = audioContext.createBufferSource();
		playbackSource.buffer = nextBuffer;
		playbackSource.connect(audioContext.destination);
		playbackSource.onended = () => {
			isPlaying = false;
			playbackSource = null;
			playNextInQueue();
		};
		playbackSource.start();
	}

	function truncatePlayback() {
		playQueue = [];
		if (playbackSource) {
			try { playbackSource.stop(); } catch (_) { }
		}
		isPlaying = false;
		playbackSource = null;
	}

	function handleElevenMessage(data) {
		switch (data.type) {
			case 'conversation_initiation_metadata':
				log('Conversation initiated');
				break;
			case 'audio': {
				const b64 = data.audio_event?.audio_base_64;
				if (!b64) return;
				// Infer sample rate from format when possible (e.g., 'pcm_16000', 'pcm_24000')
				const fmt = data.audio_event?.audio_format || '';
				if (typeof fmt === 'string' && fmt.startsWith('pcm_')) {
					const sr = parseInt(fmt.replace('pcm_', ''), 10);
					if (!Number.isNaN(sr)) elevenAudioSampleRate = sr;
				}
				const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
				receivedAudioChunks.push(bytes);
				// Simple heuristic: flush a little after we receive a chunk burst
				if (flushTimer) clearTimeout(flushTimer);
				flushTimer = setTimeout(async () => {
					const merged = concatUint8Arrays(receivedAudioChunks);
					receivedAudioChunks = [];
					const audioBuffer = await decodeToAudioBuffer(merged);
					enqueuePlayback(audioBuffer);
					elevenAudioSampleRate = null; // reset for next response
				}, cfg.elevenlabsResponseTimeout || 200);
				break;
			}
			case 'agent_response':
				log(`AI: ${data.agent_response_event?.agent_response || ''}`);
				// If we have buffered chunks waiting, flush now (agent text often arrives last)
				if (receivedAudioChunks.length > 0) {
					if (flushTimer) clearTimeout(flushTimer);
					(async () => {
						const merged = concatUint8Arrays(receivedAudioChunks);
						receivedAudioChunks = [];
						const audioBuffer = await decodeToAudioBuffer(merged);
						enqueuePlayback(audioBuffer);
						elevenAudioSampleRate = null;
					})();
				}
				break;
			case 'agent_response_correction':
				log('Agent response correction: truncating current playback');
				truncatePlayback();
				receivedAudioChunks = [];
				elevenAudioSampleRate = null;
				break;
			case 'interruption':
				log('Interruption detected');
				// Do NOT truncate here; original implementation only logged interruptions
				break;
			case 'user_transcript':
				log(`You: ${data.user_transcription_event?.user_transcript || ''}`);
				break;
			case 'ping':
				ws?.send(JSON.stringify({ type: 'pong', event_id: data.ping_event?.event_id }));
				break;
			case 'error':
				log(`Error from ElevenLabs: ${JSON.stringify(data)}`);
				break;
			default:
				break;
		}
	}

	let flushTimer = null;

	async function connect() {
		cfg = await fetchConfig();
		await setupAudio();
		const signedUrl = await getSignedUrl();
		ws = new WebSocket(signedUrl);
		ws.onopen = () => {
			log('Connected to ElevenLabs');
			const init = { type: 'conversation_initiation_client_data', conversation_config_override: {} };
			ws.send(JSON.stringify(init));
			talkBtn.disabled = false;
			// Start periodic silence sender to keep stream active for VAD
			if (silenceTimer) clearInterval(silenceTimer);
			silenceTimer = setInterval(() => {
				if (!ws || ws.readyState !== WebSocket.OPEN) return;
				const ms = cfg.audioChunkSizeMs || 100;
				if (Date.now() - lastAudioSent < ms) return;
				if (isTalking || isPlaying) return; // avoid interfering while mic or agent speaking
				const sampleRate = cfg.outputSampleRate || (audioContext?.sampleRate || 48000);
				const samples = Math.max(1, Math.round(sampleRate * (ms / 1000)));
				const silence = new Int16Array(samples);
				const b64 = btoa(String.fromCharCode.apply(null, new Uint8Array(silence.buffer)));
				ws.send(JSON.stringify({ type: 'user_audio_chunk', user_audio_chunk: b64 }));
				lastAudioSent = Date.now();
			}, cfg.audioChunkSizeMs || 100);
		};
		ws.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data);
				handleElevenMessage(data);
			} catch (e) {
				log(`WS parse error: ${e.message}`);
			}
		};
		ws.onclose = (ev) => {
			log(`Disconnected (${ev.code})`);
			talkBtn.disabled = true;
			if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
		};
		ws.onerror = (e) => {
			log('WebSocket error');
		};
	}

	connectBtn.addEventListener('click', async () => {
		connectBtn.disabled = true;
		try {
			await connect();
		} catch (e) {
			log(`Connect failed: ${e.message}`);
			connectBtn.disabled = false;
		}
	});

	// Push-to-talk UX: hold mouse or touch to stream mic frames
	function setTalking(on) {
		isTalking = on;
		if (on) {
			log('Mic: streaming');
		} else {
			log('Mic: paused');
		}
	}

	talkBtn.addEventListener('mousedown', () => setTalking(true));
	talkBtn.addEventListener('mouseup', () => setTalking(false));
	talkBtn.addEventListener('mouseleave', () => setTalking(false));
	talkBtn.addEventListener('touchstart', (e) => { e.preventDefault(); setTalking(true); });
	talkBtn.addEventListener('touchend', (e) => { e.preventDefault(); setTalking(false); });
})();


