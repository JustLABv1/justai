package speechdetect

import (
	"math"
	"math/rand"
)

// Synthetic signals for tests of code that consumes the detector.

// pcmFromSamples renders samples as PCM16 little endian.
func pcmFromSamples(samples []float64) []byte {
	out := make([]byte, 2*len(samples))
	for i, v := range samples {
		s := int16(math.Max(-1, math.Min(1, v)) * 32767)
		out[2*i], out[2*i+1] = byte(uint16(s)), byte(uint16(s)>>8)
	}
	return out
}

// SyntheticSpeech alternates voiced (harmonic) and unvoiced (noise) syllables at
// about 4 Hz with short pauses, like running speech.
func SyntheticSpeech(seconds int, seed int64) []byte {
	r := rand.New(rand.NewSource(seed))
	n := seconds * SampleRate
	x := make([]float64, n)
	syl := SampleRate / 4
	for start := 0; start < n; start += syl {
		voiced := r.Intn(3) != 0
		pause := r.Intn(5) == 0
		f0 := 90 + 40*r.Float64()
		for i := 0; i < syl && start+i < n; i++ {
			t := float64(i) / float64(syl)
			env := math.Sin(math.Pi * t)
			if pause {
				env *= 0.02
			}
			var v float64
			if voiced {
				for h := 1; h <= 8; h++ {
					v += math.Sin(2*math.Pi*f0*float64(h)*float64(start+i)/SampleRate) / float64(h)
				}
				v *= 0.12
			} else {
				v = (r.Float64()*2 - 1) * 0.25
			}
			x[start+i] = v * env
		}
	}
	return pcmFromSamples(x)
}

// SyntheticMusic is a steady chord with a slow beat, constant spectrum, no pauses.
func SyntheticMusic(seconds int) []byte {
	n := seconds * SampleRate
	x := make([]float64, n)
	for i := range x {
		t := float64(i) / SampleRate
		v := math.Sin(2*math.Pi*261.6*t) + 0.8*math.Sin(2*math.Pi*329.6*t) + 0.6*math.Sin(2*math.Pi*392*t) + 0.3*math.Sin(2*math.Pi*523.2*t)
		x[i] = 0.08 * v * (0.8 + 0.2*math.Sin(2*math.Pi*2*t))
	}
	return pcmFromSamples(x)
}

func SyntheticSilence(seconds int) []byte { return make([]byte, seconds*hopBytes) }
