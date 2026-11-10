package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/karpenter-optimizer/internal/config"
	"github.com/karpenter-optimizer/internal/kubernetes"
	"github.com/karpenter-optimizer/internal/placementhistory"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestPlacementEnv(t *testing.T) {
	t.Setenv("PLACEMENT_HISTORY_HOURS", "")
	assert.Equal(t, defaultPlacementWindow, placementWindowFromEnv())
	t.Setenv("PLACEMENT_HISTORY_HOURS", "0")
	assert.Equal(t, time.Duration(0), placementWindowFromEnv())
	t.Setenv("PLACEMENT_HISTORY_HOURS", "6")
	assert.Equal(t, 6*time.Hour, placementWindowFromEnv())
	t.Setenv("PLACEMENT_HISTORY_HOURS", "500")
	assert.Equal(t, maxPlacementWindow, placementWindowFromEnv())
	t.Setenv("PLACEMENT_HISTORY_HOURS", "x")
	assert.Equal(t, defaultPlacementWindow, placementWindowFromEnv())

	t.Setenv("PLACEMENT_HISTORY_INTERVAL_SECS", "")
	assert.Equal(t, defaultPlacementInterval, placementIntervalFromEnv())
	t.Setenv("PLACEMENT_HISTORY_INTERVAL_SECS", "5")
	assert.Equal(t, 30*time.Second, placementIntervalFromEnv())
	t.Setenv("PLACEMENT_HISTORY_INTERVAL_SECS", "300")
	assert.Equal(t, 5*time.Minute, placementIntervalFromEnv())
}

func TestParseHistoryTime(t *testing.T) {
	got, ok := parseHistoryTime("1762480800")
	assert.True(t, ok)
	assert.Equal(t, int64(1762480800), got.Unix())
	got, ok = parseHistoryTime("2026-11-07T03:00:00Z")
	assert.True(t, ok)
	assert.Equal(t, 3, got.UTC().Hour())
	_, ok = parseHistoryTime("yesterday")
	assert.False(t, ok)
	_, ok = parseHistoryTime("")
	assert.False(t, ok)
}

func TestSnapshotRoundTrip(t *testing.T) {
	nodes := []TopologyNode{{
		Name: "gpu-1", NodePool: "gpu", InstanceType: "g6e.12xlarge", CapacityType: "spot", Architecture: "amd64",
		Zone: "eu-west-1b", PodCount: 2, CreationTime: "2026-11-07T00:00:00Z",
		CPUUsage:    &kubernetes.NodeUsage{Used: 5, Capacity: 48, Allocatable: 47, Percent: 10.6},
		MemoryUsage: &kubernetes.NodeUsage{Used: 20, Capacity: 384, Allocatable: 370, Percent: 5.4},
		GPUCapacity: 4, GPUAllocated: 1, GPUModel: "L40S", GPUMemTotalMiB: 184320, GPUMemAllocatedMiB: 45000, GPUPods: 1, HamiDetected: true,
		Pods: []TopologyPod{
			{Name: "small", Namespace: "a", NodeName: "gpu-1", Requests: TopologyPodResources{CPUCores: 1, MemoryGiB: 2}},
			{Name: "vllm-0", Namespace: "llm", NodeName: "gpu-1", WorkloadName: "vllm", WorkloadType: "StatefulSet", QOSClass: "Burstable",
				Requests:   TopologyPodResources{CPUCores: 4, MemoryGiB: 18, GPU: 1, GPUMemMiB: 45000},
				GPUDevices: []kubernetes.GPUDevice{{UUID: "GPU-abc", Model: "L40S", MemoryMiB: 45000, Index: 0}}},
		},
	}, {Name: "empty", NodePool: "cpu"}}
	at := time.Unix(1762480800, 0)
	snap := snapshotFromTopology(at, nodes, map[string]string{"gpu-1": "Underutilized", "deleting": "Drifted"})
	require.Len(t, snap.Pods, 2)
	assert.Equal(t, "Underutilized", snap.Nodes["gpu-1"].DisruptionReason)
	assert.Equal(t, map[string]string{"deleting": "Drifted"}, snap.Gone, "unlisted nodes keep their reason in Gone")

	back := topologyFromSnapshot(snap)
	require.Len(t, back, 2)
	assert.Equal(t, "empty", back[0].Name)
	assert.NotNil(t, back[0].Pods)
	got := back[1]
	assert.Equal(t, "vllm-0", got.Pods[0].Name, "largest CPU request first")
	want := nodes[0]
	want.Pods = []TopologyPod{nodes[0].Pods[1], nodes[0].Pods[0]}
	assert.Equal(t, want, got)
}

func historyTestServer(t *testing.T) (*Server, *fake.Clientset) {
	t.Helper()
	server := setupTestServer()
	cs := fake.NewClientset(
		&corev1.Node{
			ObjectMeta: metav1.ObjectMeta{Name: "n1", Labels: map[string]string{"karpenter.sh/nodepool": "default", "node.kubernetes.io/instance-type": "m6i.large"}},
			Status: corev1.NodeStatus{
				Capacity:    corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("2"), corev1.ResourceMemory: resource.MustParse("8Gi")},
				Allocatable: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("2"), corev1.ResourceMemory: resource.MustParse("8Gi")},
			},
		},
		&corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Namespace: "default", Name: "web-0"},
			Spec: corev1.PodSpec{NodeName: "n1", Containers: []corev1.Container{{Name: "app", Resources: corev1.ResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("500m")},
			}}}},
			Status: corev1.PodStatus{Phase: corev1.PodRunning},
		},
		&corev1.Event{
			ObjectMeta:     metav1.ObjectMeta{Namespace: "default", Name: "ev"},
			InvolvedObject: corev1.ObjectReference{Kind: "Node", Name: "n1"},
			Source:         corev1.EventSource{Component: "karpenter"},
			Reason:         "DisruptionTerminating",
			Message:        "Disrupting Node: Empty/Delete",
			LastTimestamp:  metav1.Now(),
		},
	)
	server.k8sClient = kubernetes.NewClientWithClientset(cs)
	server.recommender = nil // no pricing calls from the test
	server.placementHistory = placementhistory.New(time.Hour, 10)
	server.placementInterval = time.Minute
	server.placementWindow = time.Hour
	return server, cs
}

func TestTopologyHistoryEndpoints(t *testing.T) {
	server, cs := historyTestServer(t)
	server.samplePlacement(context.Background())
	first, _, n := server.placementHistory.Range()
	require.Equal(t, 1, n)

	// The node goes away: the next sample records its termination.
	require.NoError(t, cs.CoreV1().Pods("default").Delete(context.Background(), "web-0", metav1.DeleteOptions{}))
	require.NoError(t, cs.CoreV1().Nodes().Delete(context.Background(), "n1", metav1.DeleteOptions{}))
	time.Sleep(1100 * time.Millisecond) // samples are second-resolution in the URL
	server.samplePlacement(context.Background())

	w := httptest.NewRecorder()
	server.router.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/topology/history?at="+strconv.FormatInt(first.Unix(), 10), nil))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var body struct {
		Nodes   []TopologyNode `json:"nodes"`
		At      int64          `json:"at"`
		History map[string]any `json:"history"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Len(t, body.Nodes, 1)
	assert.Equal(t, "n1", body.Nodes[0].Name)
	require.Len(t, body.Nodes[0].Pods, 1)
	assert.Equal(t, 0.5, body.Nodes[0].Pods[0].Requests.CPUCores)
	assert.Equal(t, float64(2), body.History["samples"])

	w = httptest.NewRecorder()
	server.router.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/topology/events?since=1h", nil))
	require.Equal(t, http.StatusOK, w.Code)
	var ev struct {
		Events []placementhistory.Event `json:"events"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &ev))
	require.Len(t, ev.Events, 1)
	assert.Equal(t, "node-removed", ev.Events[0].Type)
	assert.Equal(t, "Empty", ev.Events[0].Reason)
	assert.Equal(t, 1, ev.Events[0].Pods)

	for _, tc := range []struct {
		url  string
		code int
	}{
		{"/api/v1/topology/history", http.StatusBadRequest},
		{"/api/v1/topology/history?at=1", http.StatusNotFound},
		{"/api/v1/topology/events?since=soon", http.StatusBadRequest},
		{"/api/v1/topology/events", http.StatusOK},
	} {
		w := httptest.NewRecorder()
		server.router.ServeHTTP(w, httptest.NewRequest("GET", tc.url, nil))
		assert.Equal(t, tc.code, w.Code, tc.url)
	}
}

func TestTopologyHistoryDisabled(t *testing.T) {
	server := setupTestServer()
	require.Nil(t, server.placementHistory, "no k8s client, no store")
	for _, url := range []string{"/api/v1/topology/history?at=1", "/api/v1/topology/events"} {
		w := httptest.NewRecorder()
		server.router.ServeHTTP(w, httptest.NewRequest("GET", url, nil))
		assert.Equal(t, http.StatusServiceUnavailable, w.Code, url)
	}
}

func TestEventsEmptyIsArray(t *testing.T) {
	server, _ := historyTestServer(t)
	w := httptest.NewRecorder()
	server.router.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/topology/events", nil))
	assert.Contains(t, w.Body.String(), `"events":[]`)
	assert.NotContains(t, w.Body.String(), `"from"`)
}

// fakePlacementStore is an in-memory placementdurable.Store.
type fakePlacementStore struct {
	recs    []placementhistory.Record
	addErr  error
	loadErr error
	closed  bool
}

func (f *fakePlacementStore) Add(r placementhistory.Record) error {
	if f.addErr != nil {
		return f.addErr
	}
	f.recs = append(f.recs, r)
	return nil
}

func (f *fakePlacementStore) Load(time.Time, time.Duration) ([]placementhistory.Record, error) {
	return f.recs, f.loadErr
}

func (f *fakePlacementStore) Close() error { f.closed = true; return nil }

func TestPlacementDurableWriteAndRestore(t *testing.T) {
	server, _ := historyTestServer(t)
	store := &fakePlacementStore{}
	server.placementDurable = store

	server.samplePlacement(context.Background())
	time.Sleep(10 * time.Millisecond)
	server.samplePlacement(context.Background())
	require.Len(t, store.recs, 2)
	assert.True(t, store.recs[0].Keyframe)
	assert.False(t, store.recs[1].Keyframe)

	// A failed write forces the next sample to be a full keyframe.
	store.addErr = assert.AnError
	time.Sleep(10 * time.Millisecond)
	server.samplePlacement(context.Background())
	store.addErr = nil
	time.Sleep(10 * time.Millisecond)
	server.samplePlacement(context.Background())
	require.Len(t, store.recs, 3)
	assert.True(t, store.recs[2].Keyframe, "the sample after a failed write is a keyframe")

	// A fresh process restores what was saved.
	fresh := placementhistory.New(time.Hour, 10)
	assert.Equal(t, 3, restorePlacement(store, fresh, time.Hour, time.Now()))
	snap, ok := fresh.At(time.Now())
	require.True(t, ok)
	assert.Contains(t, snap.Nodes, "n1")
	assert.Contains(t, snap.Pods, "default/web-0")

	// Read errors keep the store empty; Close closes the durable store.
	broken := &fakePlacementStore{loadErr: assert.AnError}
	assert.Equal(t, 0, restorePlacement(broken, placementhistory.New(time.Hour, 10), time.Hour, time.Now()))
	server.Close()
	assert.True(t, store.closed)
}

func TestInitPlacementDurableWithoutDatabase(t *testing.T) {
	mem := placementhistory.New(time.Hour, 10)
	assert.Nil(t, initPlacementDurable(&config.Config{}, mem, time.Hour))
	assert.Nil(t, initPlacementDurable(&config.Config{PlacementHistoryDSN: "postgres://u:p@127.0.0.1:1/db?sslmode=disable"}, mem, time.Hour))
}
