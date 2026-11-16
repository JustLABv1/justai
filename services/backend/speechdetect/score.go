package speechdetect

// Thresholds were calibrated on a recording of the Bundestag "Parlamentsradio"
// music programme (ZCR variation 0.36-0.79, syllable share 0.20-0.44) against
// synthetic German speech (ZCR variation 1.08-1.64, syllable share 0.46-0.78).
// The ZCR variation is the stronger cue: speech alternates between voiced and
// unvoiced sounds, while music keeps a steadier spectrum. Real parliamentary
// audio (room noise, applause) should be re-checked against recordings; the
// gate's hysteresis absorbs short misclassifications.
func score(f Features) float64 {
	z := clamp01((f.ZCRStd - 0.75) / 0.45)
	m := clamp01((f.Mod4Hz - 0.30) / 0.25)
	return 0.7*z + 0.3*m
}

// SpeechThreshold is the minimum Score for a window to count as speech.
const SpeechThreshold = 0.5
