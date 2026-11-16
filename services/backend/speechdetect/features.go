// Package speechdetect tells spoken word from music and silence in 16 kHz mono
// PCM16 audio, using cheap time-domain features (no model, no network). It is
// meant for coarse decisions on broadcast streams, such as "has the parliament
// session started" or "has the programme gone back to music".
package speechdetect

import "math"

const (
	SampleRate = 16000
	frameLen   = 320 // 20 ms
	hopLen     = 160 // 10 ms
	framesPerS = SampleRate / hopLen
)

// Features describes one analysis window.
type Features struct {
	RMS      float64 // mean level, 0..1
	LowRatio float64 // share of frames clearly quieter than average (pauses between words)
	ZCRStd   float64 // variation of the zero-crossing rate (voiced/unvoiced alternation)
	Mod4Hz   float64 // share of envelope energy at syllable rate (2-8 Hz)
	Score    float64 // 0..1 speech likelihood
	Silent   bool
}

// silenceRMS is the level below which a window is treated as silence.
const silenceRMS = 0.003

// Analyze computes features for a window of PCM16 little-endian samples.
// Windows shorter than one second yield Silent=true and Score 0.
func Analyze(pcm []byte) Features {
	n := len(pcm) / 2
	if n < SampleRate {
		return Features{Silent: true}
	}
	samples := make([]float64, n)
	for i := range samples {
		samples[i] = float64(int16(uint16(pcm[2*i])|uint16(pcm[2*i+1])<<8)) / 32768
	}
	frames := (n-frameLen)/hopLen + 1
	rms := make([]float64, frames)
	zcr := make([]float64, frames)
	var sum float64
	for f := 0; f < frames; f++ {
		seg := samples[f*hopLen : f*hopLen+frameLen]
		var e float64
		crossings := 0
		for i, v := range seg {
			e += v * v
			if i > 0 && (v >= 0) != (seg[i-1] >= 0) {
				crossings++
			}
		}
		rms[f] = math.Sqrt(e / frameLen)
		zcr[f] = float64(crossings) / frameLen
		sum += rms[f]
	}
	mean := sum / float64(frames)
	out := Features{RMS: mean}
	if mean < silenceRMS {
		out.Silent = true
		return out
	}
	low := 0
	for _, v := range rms {
		if v < 0.5*mean {
			low++
		}
	}
	out.LowRatio = float64(low) / float64(frames)
	var zm float64
	for _, v := range zcr {
		zm += v
	}
	zm /= float64(frames)
	var zv float64
	for _, v := range zcr {
		zv += (v - zm) * (v - zm)
	}
	if zm > 0 {
		out.ZCRStd = math.Sqrt(zv/float64(frames)) / zm
	}
	out.Mod4Hz = syllableShare(rms)
	out.Score = score(out)
	return out
}

// syllableShare is the fraction of envelope fluctuation energy between 2 and 8 Hz.
func syllableShare(env []float64) float64 {
	n := len(env)
	var m float64
	for _, v := range env {
		m += v
	}
	m /= float64(n)
	x := make([]float64, n)
	for i, v := range env {
		x[i] = (v - m) * (0.5 - 0.5*math.Cos(2*math.Pi*float64(i)/float64(n-1))) // Hann
	}
	band := func(lo, hi float64) float64 {
		var total float64
		for f := lo; f <= hi; f += 0.25 {
			w := 2 * math.Pi * f / framesPerS
			var re, im float64
			for i, v := range x {
				re += v * math.Cos(w*float64(i))
				im -= v * math.Sin(w*float64(i))
			}
			total += re*re + im*im
		}
		return total
	}
	focus := band(2, 8)
	all := band(0.5, 25)
	if all <= 0 {
		return 0
	}
	return focus / all
}

func clamp01(v float64) float64 { return math.Max(0, math.Min(1, v)) }

// score is filled in by calibration; see score.go.
