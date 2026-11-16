package speechdetect

import (
	"fmt"
	"os"
	"testing"
)

// Prints features per 3 s window for recordings in $SPEECHDETECT_CALIBRATION
// (files music.pcm, sp_*.pcm). Skipped when the variable is unset.
func TestCalibrationDump(t *testing.T) {
	dir := os.Getenv("SPEECHDETECT_CALIBRATION")
	if dir == "" {
		t.Skip("no calibration data")
	}
	for _, name := range []string{"music.pcm", "sp_Eddy.pcm", "sp_Rocko.pcm", "sp_Grandpa.pcm", "sp_Flo.pcm", "sp_Sandy.pcm", "sp_Shelley.pcm", "sp_Reed.pcm"} {
		data, err := os.ReadFile(dir + "/" + name)
		if err != nil {
			t.Fatal(err)
		}
		win := 3 * SampleRate * 2
		for off := 0; off+win <= len(data); off += win {
			f := Analyze(data[off : off+win])
			fmt.Printf("%-16s rms=%.3f low=%.2f zcrstd=%.2f mod=%.2f\n", name, f.RMS, f.LowRatio, f.ZCRStd, f.Mod4Hz)
		}
	}
}
