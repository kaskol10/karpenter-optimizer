package kubernetes

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestCheckBlockingConstraintsPDBGrouping(t *testing.T) {
	blockingPDB := policyv1.PodDisruptionBudget{
		ObjectMeta: metav1.ObjectMeta{Namespace: "prod", Name: "api"},
		Spec: policyv1.PodDisruptionBudgetSpec{
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "api"}},
		},
		Status: policyv1.PodDisruptionBudgetStatus{
			CurrentHealthy:     1,
			DesiredHealthy:     1,
			DisruptionsAllowed: 0,
		},
	}
	healthyPDB := policyv1.PodDisruptionBudget{
		ObjectMeta: metav1.ObjectMeta{Namespace: "prod", Name: "web"},
		Spec: policyv1.PodDisruptionBudgetSpec{
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "web"}},
		},
		Status: policyv1.PodDisruptionBudgetStatus{
			CurrentHealthy:     3,
			DesiredHealthy:     3,
			DisruptionsAllowed: 1,
		},
	}

	np := &nodePods{
		checks: []*podCheckInfo{
			{namespace: "prod", name: "api-1", labels: map[string]string{"app": "api"}},   // matched by blocking PDB
			{namespace: "prod", name: "api-2", labels: map[string]string{"app": "api"}},   // same PDB, second pod
			{namespace: "prod", name: "web-1", labels: map[string]string{"app": "web"}},   // matched by healthy PDB (not blocking)
			{namespace: "prod", name: "other", labels: map[string]string{"app": "other"}}, // matches no PDB, not deleting
			{namespace: "prod", name: "dying", labels: map[string]string{"app": "other"}, deleting: true}, // stuck terminating
		},
	}

	disruption := &NodeDisruptionInfo{NodeName: "node-1"}
	c := &Client{}
	c.checkBlockingConstraints(disruption, np, []policyv1.PodDisruptionBudget{blockingPDB, healthyPDB})

	if !disruption.IsBlocked {
		t.Fatal("expected disruption to be blocked")
	}
	if len(disruption.BlockingPDBs) != 1 || disruption.BlockingPDBs[0] != "prod/api" {
		t.Errorf("BlockingPDBs = %v, want [prod/api]", disruption.BlockingPDBs)
	}
	if len(disruption.BlockingPDBDetails) != 1 {
		t.Fatalf("BlockingPDBDetails = %d entries, want 1", len(disruption.BlockingPDBDetails))
	}
	detail := disruption.BlockingPDBDetails[0]
	if len(detail.BlockingPods) != 2 {
		t.Errorf("PDB blockingPods = %v, want 2 api pods", detail.BlockingPods)
	}
	// blockingPods should contain the 2 api pods + the dying pod (3 total)
	if len(disruption.BlockingPods) != 3 {
		t.Errorf("BlockingPods = %v, want 3 entries", disruption.BlockingPods)
	}
	if !contains(disruption.BlockingPods, "prod/api-1") || !contains(disruption.BlockingPods, "prod/api-2") || !contains(disruption.BlockingPods, "prod/dying") {
		t.Errorf("BlockingPods = %v, want to include api-1, api-2, dying", disruption.BlockingPods)
	}
	// The healthy PDB and non-matching pods must not appear
	if contains(disruption.BlockingPods, "prod/web-1") || contains(disruption.BlockingPods, "prod/other") {
		t.Errorf("BlockingPods = %v, must not include web-1 or other", disruption.BlockingPods)
	}
	// Neither PDB in this fixture sets minAvailable/maxUnavailable
	if detail.MinAvailable != "" || detail.MaxUnavailable != "" {
		t.Errorf("expected empty minAvailable/maxUnavailable, got %q/%q", detail.MinAvailable, detail.MaxUnavailable)
	}
}

func TestCheckBlockingConstraintsEmptyPods(t *testing.T) {
	c := &Client{}
	disruption := &NodeDisruptionInfo{NodeName: "node-1"}

	// #given: no pods on the node
	c.checkBlockingConstraints(disruption, nil, []policyv1.PodDisruptionBudget{})

	// #then: nothing flagged
	if disruption.IsBlocked {
		t.Error("expected no blocking with empty pods")
	}
	if len(disruption.BlockingPods) != 0 || len(disruption.BlockingPDBs) != 0 {
		t.Errorf("expected no blocking pods/PDBs, got %v / %v", disruption.BlockingPods, disruption.BlockingPDBs)
	}
}

func TestNodeCapacityType(t *testing.T) {
	node := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Labels: map[string]string{"karpenter.sh/capacity-type": "spot"},
		},
	}
	if got := nodeCapacityType(node); got != "spot" {
		t.Errorf("nodeCapacityType = %q, want spot", got)
	}
	nodeNoLabel := &corev1.Node{}
	if got := nodeCapacityType(nodeNoLabel); got != "on-demand" {
		t.Errorf("nodeCapacityType = %q, want on-demand", got)
	}
}
