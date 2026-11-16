package speechdetect

import (
	"os"
	"testing"
	"time"
)

func TestAnalyzeSeparatesSyntheticSpeechFromMusicAndSilence(t *testing.T) {
	if f := Analyze(SyntheticSpeech(3, 1)); f.Score < SpeechThreshold {
		t.Errorf("speech scored %.2f (%+v)", f.Score, f)
	}
	if f := Analyze(SyntheticMusic(3)); f.Score >= SpeechThreshold {
		t.Errorf("music scored %.2f (%+v)", f.Score, f)
	}
	if f := Analyze(SyntheticSilence(3)); !f.Silent || f.Score != 0 {
		t.Errorf("silence not detected: %+v", f)
	}
	if f := Analyze(SyntheticSpeech(1, 1)[:1000]); !f.Silent {
		t.Error("tiny windows must not be classified")
	}
}

func TestGateOpensOnSpeechAndClosesOnlyAfterLongNonSpeech(t *testing.T) {
	g := NewGate(false)
	g.Feed(SyntheticMusic(30))
	if g.Open() {
		t.Fatal("music opened the gate")
	}
	g.Feed(SyntheticSpeech(2, 2))
	if g.Open() {
		t.Fatal("opened before enough speech")
	}
	g.Feed(SyntheticSpeech(10, 3))
	if !g.Open() {
		t.Fatal("speech did not open the gate")
	}
	// A short stretch of music or applause must not close it.
	g.Feed(SyntheticMusic(8))
	if !g.Open() {
		t.Fatal("short music closed the gate")
	}
	g.Feed(SyntheticSpeech(6, 4))
	if g.NonSpeechFor() != 0 && g.NonSpeechFor() > 3*time.Second {
		t.Fatalf("non-speech timer not reset: %v", g.NonSpeechFor())
	}
	g.Feed(SyntheticMusic(40))
	if g.Open() {
		t.Fatal("long music did not close the gate")
	}
	if g.NonSpeechFor() < 30*time.Second {
		t.Fatalf("non-speech timer = %v", g.NonSpeechFor())
	}
}

func TestGateHandlesArbitraryChunkSizesIncludingOddBytes(t *testing.T) {
	data := SyntheticSpeech(12, 5)
	g := NewGate(false)
	for off := 0; off < len(data); off += 997 { // odd, unaligned chunks
		end := off + 997
		if end > len(data) {
			end = len(data)
		}
		g.Feed(data[off:end])
	}
	if !g.Open() {
		t.Fatal("chunked speech did not open the gate")
	}
}

// With recordings in $SPEECHDETECT_CALIBRATION (music.pcm and sp_*.pcm, 16 kHz
// mono PCM16) this checks real audio, including speech with added noise.
func TestRealRecordings(t *testing.T) {
	dir := os.Getenv("SPEECHDETECT_CALIBRATION")
	if dir == "" {
		t.Skip("no calibration data")
	}
	music, err := os.ReadFile(dir + "/music.pcm")
	if err != nil {
		t.Fatal(err)
	}
	g := NewGate(false)
	g.Feed(music)
	if g.Open() {
		t.Error("real music opened the gate")
	}
	for _, name := range []string{"Eddy", "Rocko", "Grandpa", "Flo", "Sandy", "Shelley", "Reed"} {
		speech, err := os.ReadFile(dir + "/sp_" + name + ".pcm")
		if err != nil {
			t.Fatal(err)
		}
		g := NewGate(false)
		g.Feed(speech)
		if !g.Open() {
			t.Errorf("%s: speech did not open the gate", name)
		}
	}
}
