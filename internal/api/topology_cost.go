package api

// attachTopologyCost prices each topology node from the instance price
// cache, for the Topology Cost lens. A node keeps a nil CostPerHour when it
// has no instance type or no known price.
func attachTopologyCost(nodes []TopologyNode, price nodePrice) {
	price = cachedPricer(price)
	for i := range nodes {
		n := &nodes[i]
		if n.InstanceType == "" {
			continue
		}
		capacityType := pricedCapacityType(n.CapacityType)
		cost, source, ok := price(n.InstanceType, capacityType)
		if !ok {
			continue
		}
		n.CostPerHour = &cost
		n.CostSource = source
		n.PricedAs = capacityType
	}
}
