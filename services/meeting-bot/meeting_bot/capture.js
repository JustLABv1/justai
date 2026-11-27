// Runs in every frame of the meeting page before the page's own scripts.
//
// It taps the audio the meeting sends to the bot: every remote audio track of every
// RTCPeerConnection is mixed, resampled to 16 kHz mono PCM16 and handed to the bot
// through the `__justaiAudio(base64, trackCount)` binding in chunks of about 100 ms.
// Nothing here sends audio into the meeting.
;(() => {
  if (window.__justaiCapture) return
  const TARGET_RATE = 16000
  const CHUNK_SECONDS = 0.1
  const peers = new Set()
  const tracks = new Map()
  let context = null
  let mixer = null
  let starting = null

  const workletSource = `
    class JustAICaptureProcessor extends AudioWorkletProcessor {
      constructor() {
        super()
        this.size = Math.round(sampleRate * ${CHUNK_SECONDS})
        this.buffer = new Float32Array(this.size)
        this.filled = 0
      }
      process(inputs) {
        const input = inputs[0]
        if (input && input.length > 0) {
          const channels = input.length
          const frames = input[0].length
          for (let i = 0; i < frames; i++) {
            let sum = 0
            for (let c = 0; c < channels; c++) sum += input[c][i]
            this.buffer[this.filled++] = sum / channels
            if (this.filled === this.size) {
              this.port.postMessage(this.buffer)
              this.buffer = new Float32Array(this.size)
              this.filled = 0
            }
          }
        }
        return true
      }
    }
    registerProcessor("justai-capture", JustAICaptureProcessor)
  `

  // Averages the source samples that fall into each output sample (a box filter),
  // which keeps speech intelligible without aliasing hiss from plain decimation.
  function resample(samples, fromRate) {
    if (fromRate === TARGET_RATE) return samples
    const ratio = fromRate / TARGET_RATE
    const length = Math.floor(samples.length / ratio)
    const out = new Float32Array(length)
    for (let i = 0; i < length; i++) {
      const start = Math.floor(i * ratio)
      const end = Math.min(samples.length, Math.floor((i + 1) * ratio))
      let sum = 0
      for (let j = start; j < end; j++) sum += samples[j]
      out[i] = sum / Math.max(1, end - start)
    }
    return out
  }

  function toBase64PCM16(samples) {
    const bytes = new Uint8Array(samples.length * 2)
    const view = new DataView(bytes.buffer)
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]))
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
    let binary = ""
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    return btoa(binary)
  }

  function deliver(samples) {
    if (typeof window.__justaiAudio !== "function") return
    const pcm = resample(samples, context.sampleRate)
    window.__justaiAudio(toBase64PCM16(pcm), tracks.size).catch(() => {})
  }

  function start() {
    if (starting) return starting
    starting = (async () => {
      context = new AudioContext()
      mixer = context.createGain()
      const silent = context.createGain()
      silent.gain.value = 0
      try {
        const url = URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" }))
        await context.audioWorklet.addModule(url)
        URL.revokeObjectURL(url)
        const node = new AudioWorkletNode(context, "justai-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2 })
        node.port.onmessage = (event) => deliver(event.data)
        mixer.connect(node)
        node.connect(silent)
      } catch {
        // A page whose CSP forbids blob: workers still gets audio, through the
        // deprecated but universally available ScriptProcessorNode.
        const size = 4096
        const processor = context.createScriptProcessor(size, 2, 1)
        let pending = []
        let pendingLength = 0
        const chunk = Math.round(context.sampleRate * CHUNK_SECONDS)
        processor.onaudioprocess = (event) => {
          const input = event.inputBuffer
          const mono = new Float32Array(input.length)
          for (let c = 0; c < input.numberOfChannels; c++) {
            const data = input.getChannelData(c)
            for (let i = 0; i < data.length; i++) mono[i] += data[i] / input.numberOfChannels
          }
          pending.push(mono)
          pendingLength += mono.length
          if (pendingLength >= chunk) {
            const all = new Float32Array(pendingLength)
            let offset = 0
            for (const part of pending) {
              all.set(part, offset)
              offset += part.length
            }
            pending = []
            pendingLength = 0
            deliver(all)
          }
        }
        mixer.connect(processor)
        processor.connect(silent)
      }
      silent.connect(context.destination)
      if (context.state !== "running") await context.resume().catch(() => {})
    })()
    return starting
  }

  async function attach(track) {
    if (!track || track.kind !== "audio" || tracks.has(track.id) || track.readyState === "ended") return
    tracks.set(track.id, null)
    await start()
    const stream = new MediaStream([track])
    // Chromium delivers silence to Web Audio for a remote WebRTC track unless the
    // track also plays in a media element; a muted one is enough.
    const element = new Audio()
    element.muted = true
    element.srcObject = stream
    element.play().catch(() => {})
    const source = context.createMediaStreamSource(stream)
    source.connect(mixer)
    tracks.set(track.id, { source, element })
    track.addEventListener("ended", () => detach(track.id), { once: true })
  }

  function detach(id) {
    const entry = tracks.get(id)
    tracks.delete(id)
    if (!entry) return
    entry.source.disconnect()
    entry.element.srcObject = null
  }

  const Original = window.RTCPeerConnection
  if (typeof Original === "function") {
    class CapturingPeerConnection extends Original {
      constructor(...args) {
        super(...args)
        peers.add(new WeakRef(this))
        this.addEventListener("track", (event) => void attach(event.track))
      }
    }
    window.RTCPeerConnection = CapturingPeerConnection
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = CapturingPeerConnection
  }

  // Tracks can also arrive on reused transceivers without a new "track" event.
  setInterval(() => {
    for (const ref of peers) {
      const peer = ref.deref()
      if (!peer || peer.connectionState === "closed") {
        peers.delete(ref)
        continue
      }
      for (const receiver of peer.getReceivers()) void attach(receiver.track)
    }
    for (const [id, entry] of tracks) {
      if (entry && entry.source.mediaStream.getAudioTracks().every((t) => t.readyState === "ended")) detach(id)
    }
    if (context && context.state === "suspended") context.resume().catch(() => {})
  }, 2000)

  window.__justaiCapture = {
    status: () => ({ tracks: tracks.size, context: context ? context.state : "none", peers: peers.size }),
  }
})()
