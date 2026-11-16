package speechdetect

import "time"

const (
	hopBytes    = SampleRate * 2 // one second of PCM16
	windowBytes = 3 * hopBytes   // analysis window
	openHops    = 3              // consecutive speech decisions to open
	closeHops   = 20             // consecutive non-speech decisions to close
)

// Gate turns a stream of PCM chunks into a stable speech/non-speech state with
// hysteresis, so applause, a short pause or one odd window do not flip it.
type Gate struct {
	open       bool
	pending    []byte // bytes not yet forming a full hop
	window     []byte // most recent audio, at most windowBytes
	speechRun  int
	quietRun   int
	nonSpeech  time.Duration // audio time since the last speech decision
	lastScore  float64
	lastSilent bool
	seen       bool
}

// NewGate creates a gate. Start it open when audio is already known to be
// speech (capture in progress) and closed when waiting for speech to begin.
func NewGate(open bool) *Gate { return &Gate{open: open} }

// Open reports whether speech is currently considered to be playing.
func (g *Gate) Open() bool { return g.open }

// NonSpeechFor is the audio time since the last window that looked like speech.
func (g *Gate) NonSpeechFor() time.Duration { return g.nonSpeech }

// SpeechSeen reports whether any window has looked like speech since the gate was created.
func (g *Gate) SpeechSeen() bool { return g.seen }

// LastScore returns the latest window score and whether it was silent.
func (g *Gate) LastScore() (float64, bool) { return g.lastScore, g.lastSilent }

// Feed adds PCM16 little-endian audio of any length.
func (g *Gate) Feed(pcm []byte) {
	g.pending = append(g.pending, pcm...)
	for len(g.pending) >= hopBytes {
		hop := g.pending[:hopBytes]
		g.window = append(g.window, hop...)
		if len(g.window) > windowBytes {
			g.window = g.window[len(g.window)-windowBytes:]
		}
		g.pending = append([]byte(nil), g.pending[hopBytes:]...)
		g.decide()
	}
}

func (g *Gate) decide() {
	f := Analyze(g.window)
	g.lastScore, g.lastSilent = f.Score, f.Silent
	if !f.Silent && f.Score >= SpeechThreshold {
		g.speechRun++
		g.seen = true
		g.quietRun = 0
		g.nonSpeech = 0
		if !g.open && g.speechRun >= openHops {
			g.open = true
		}
		return
	}
	g.quietRun++
	g.speechRun = 0
	g.nonSpeech += time.Second
	if g.open && g.quietRun >= closeHops {
		g.open = false
	}
}
