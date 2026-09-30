// Package power estimates a cluster's fleet power draw from the instance
// types of its nodes, using a static wattage table per EC2 family. This is a
// coarse, clearly-labeled estimate (no live power telemetry), intended to give
// operators a sense of the order of magnitude of energy the cluster consumes.
package power

import "strings"

// Result is the fleet power estimate over a set of instance types.
type Result struct {
	Watts        float64 `json:"watts"`        // summed estimate for covered nodes
	NodeCount    int     `json:"nodeCount"`    // total nodes provided
	CoveredNodes int     `json:"coveredNodes"` // nodes whose family is in the table
	CoveragePct  float64 `json:"coveragePct"`  // covered/total as 0-100
}

// familyWatts maps an EC2 instance family (the prefix before the first dot,
// e.g. "m5", "p4d", "g5g") to a representative power draw in watts. Values are
// static estimates tuned to the family's most common size. Families not listed
// are treated as uncovered (excluded from the total and the coverage %).
var familyWatts = map[string]float64{
	// GPU instances
	"p3":    3500,
	"p3dn":  5200,
	"p4d":   3300,
	"p4de":  3300,
	"p5":    10200,
	"p5e":   10200,
	"g5":    500,
	"g5g":   400,
	"g6":    350,
	"g4dn":  350,
	"g4ad":  350,
	"g3s":   250,
	"trn1":  300,
	"trn1n": 1200,
	"inf1":  500,
	"inf2":  700,
	// General purpose
	"m5":  300,
	"m5n": 300,
	"m5d": 320,
	"m6g": 250,
	"m6i": 300,
	"m7g": 300,
	"m7i": 350,
	"t2":  100,
	"t3":  150,
	"t3a": 150,
	"t4g": 150,
	// Compute optimized
	"c5":  350,
	"c5n": 380,
	"c5d": 350,
	"c6g": 300,
	"c6i": 350,
	"c7g": 350,
	"c7i": 400,
	// Memory optimized
	"r5":    400,
	"r5d":   400,
	"r5b":   420,
	"r6g":   350,
	"r6i":   400,
	"r7g":   400,
	"r7i":   450,
	"x1":    1200,
	"x1e":   1200,
	"x2dn":  1500,
	"x2idn": 1200,
	"z1d":   900,
	// Storage / HPC
	"i3":    800,
	"i3en":  1200,
	"i4i":   1200,
	"d3":    800,
	"hpc7g": 1000,
}

// familyOf returns the EC2 family portion of an instance type (the text before
// the first dot). "m5.2xlarge" -> "m5"; "g5g.8xlarge" -> "g5g".
func familyOf(instanceType string) string {
	if i := strings.Index(instanceType, "."); i > 0 {
		return instanceType[:i]
	}
	return instanceType
}

// Estimate sums the static wattage for each instance type whose family is in
// the table. Types with unknown families are excluded from the wattage total
// but still counted toward the coverage percentage.
func Estimate(instanceTypes []string) Result {
	res := Result{NodeCount: len(instanceTypes)}
	for _, it := range instanceTypes {
		if it == "" {
			continue
		}
		if watts, ok := familyWatts[familyOf(it)]; ok {
			res.Watts += watts
			res.CoveredNodes++
		}
	}
	if res.NodeCount > 0 {
		res.CoveragePct = (float64(res.CoveredNodes) / float64(res.NodeCount)) * 100
	}
	return res
}
