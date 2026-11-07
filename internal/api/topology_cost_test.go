package api

import "testing"

func TestAttachTopologyCost(t *testing.T) {
	t.Parallel()

	// #given: two nodes of one type (looked up once), an unknown capacity
	// type (priced as on-demand), an unpriceable type and no instance type
	nodes := []TopologyNode{
		{Name: "a", InstanceType: "g6e.12xlarge", CapacityType: "spot"},
		{Name: "b", InstanceType: "g6e.12xlarge", CapacityType: "spot"},
		{Name: "c", InstanceType: "m7i.large"},
		{Name: "d", InstanceType: "mystery.metal", CapacityType: "on-demand"},
		{Name: "e"},
	}
	calls := 0
	price := func(instanceType, capacityType string) (float64, string, bool) {
		calls++
		switch instanceType + "/" + capacityType {
		case "g6e.12xlarge/spot":
			return 2.5, "aws-pricing-api", true
		case "m7i.large/on-demand":
			return 0.1, "hardcoded", true
		}
		return 0, "", false
	}

	// #when
	attachTopologyCost(nodes, price)

	// #then
	if n := nodes[0]; n.CostPerHour == nil || *n.CostPerHour != 2.5 || n.CostSource != "aws-pricing-api" || n.PricedAs != "spot" {
		t.Errorf("a = %v %q %q, want 2.5 aws-pricing-api spot", n.CostPerHour, n.CostSource, n.PricedAs)
	}
	if n := nodes[2]; n.CostPerHour == nil || *n.CostPerHour != 0.1 || n.PricedAs != "on-demand" {
		t.Errorf("c = %v %q, want 0.1 priced as on-demand", n.CostPerHour, n.PricedAs)
	}
	if nodes[3].CostPerHour != nil || nodes[4].CostPerHour != nil {
		t.Errorf("unpriceable nodes must keep a nil cost, got %v / %v", nodes[3].CostPerHour, nodes[4].CostPerHour)
	}
	if calls != 3 {
		t.Errorf("price lookups = %d, want 3 (one per instance and capacity type)", calls)
	}
}
