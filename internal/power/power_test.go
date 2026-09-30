package power

import (
	"testing"
)

func TestEstimateKnownAndUnknownFamilies(t *testing.T) {
	// #given: a mix of covered and uncovered instance types
	in := []string{"m5.2xlarge", "p4d.24xlarge", "m5.2xlarge", "weird99.xlarge"}

	// #when
	res := Estimate(in)

	// #then
	if res.NodeCount != 4 {
		t.Fatalf("nodeCount = %d, want 4", res.NodeCount)
	}
	if res.CoveredNodes != 3 {
		t.Errorf("coveredNodes = %d, want 3", res.CoveredNodes)
	}
	want := familyWatts["m5"]*2 + familyWatts["p4d"]
	if res.Watts != want {
		t.Errorf("watts = %v, want %v", res.Watts, want)
	}
	if res.CoveragePct < 74.9 || res.CoveragePct > 75.1 {
		t.Errorf("coveragePct = %v, want 75", res.CoveragePct)
	}
}

func TestEstimateEmpty(t *testing.T) {
	res := Estimate(nil)
	if res.Watts != 0 || res.NodeCount != 0 || res.CoveragePct != 0 {
		t.Errorf("expected all-zero result, got %+v", res)
	}
}

func TestEstimateIgnoresEmptyTypes(t *testing.T) {
	res := Estimate([]string{"", "m5.large", ""})
	if res.NodeCount != 3 || res.CoveredNodes != 1 {
		t.Errorf("nodeCount/covered = %d/%d, want 3/1", res.NodeCount, res.CoveredNodes)
	}
	if res.Watts != familyWatts["m5"] {
		t.Errorf("watts = %v, want %v", res.Watts, familyWatts["m5"])
	}
}

func TestFamilyOf(t *testing.T) {
	cases := map[string]string{
		"m5.2xlarge":  "m5",
		"g5g.8xlarge": "g5g",
		"p4d.24xl":    "p4d",
		"nodot":       "nodot",
	}
	for in, want := range cases {
		if got := familyOf(in); got != want {
			t.Errorf("familyOf(%q) = %q, want %q", in, got, want)
		}
	}
}
