package agent

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"
)

// newTestLearningAgent builds a LearningAgent backed by a temp file.
func newTestLearningAgent(t *testing.T) *LearningAgent {
	t.Helper()
	agent, err := NewLearningAgent(t.TempDir() + "/history.json")
	if err != nil {
		t.Fatalf("NewLearningAgent: %v", err)
	}
	return agent
}

func sampleOutcome() OptimizationOutcome {
	return OptimizationOutcome{
		PlanID:           "plan-1",
		NodePoolName:     "general",
		Strategy:         StrategyBalanced,
		AppliedAt:        time.Now(),
		PredictedSavings: 100,
		ActualSavings:    80,
	}
}

// TestRecordOutcomeDoesNotDeadlock is a regression test for the self-deadlock
// where RecordOutcome held historyMu.Lock() while saveHistory() re-took the
// same non-reentrant mutex (RLock), hanging the first POST /agent/outcomes
// forever.
func TestRecordOutcomeDoesNotDeadlock(t *testing.T) {
	// #given
	agent := newTestLearningAgent(t)

	// #when — run in a goroutine so a regression hangs this test via timeout
	// instead of freezing the whole test binary.
	done := make(chan error, 1)
	go func() {
		done <- agent.RecordOutcome(context.Background(), sampleOutcome())
	}()

	// #then
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("RecordOutcome returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RecordOutcome deadlocked (timed out after 5s)")
	}
	if got := agent.GetHistoryCount(); got != 1 {
		t.Fatalf("history count = %d, want 1", got)
	}
}

// TestRecordOutcomeConcurrentReaders verifies readers are not stalled while an
// outcome is being recorded (persistence and learning happen outside the
// write lock).
func TestRecordOutcomeConcurrentReaders(t *testing.T) {
	// Run the whole scenario in a goroutine so a regression (e.g. a lock
	// self-deadlock) hangs this test via the timeout instead of freezing the
	// entire test binary.
	done := make(chan error, 1)
	go func() { done <- runConcurrentReaderScenario(t) }()

	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("concurrent record/read scenario deadlocked (timed out after 30s)")
	}
}

func runConcurrentReaderScenario(t *testing.T) error {
	t.Helper()

	// #given — constructed directly (no t.Fatalf, we're off the test goroutine)
	agent, err := NewLearningAgent(t.TempDir() + "/history.json")
	if err != nil {
		return fmt.Errorf("NewLearningAgent: %w", err)
	}

	const writers = 4
	const iters = 25

	stop := make(chan struct{})

	// Reader goroutines must stay responsive throughout.
	var readers sync.WaitGroup
	for i := 0; i < 2; i++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				agent.GetHistory()
				agent.GetStrategySuccessRate(StrategyBalanced)
			}
		}()
	}

	// #when — concurrent writers
	errCh := make(chan error, writers*iters)
	var writersWG sync.WaitGroup
	for w := 0; w < writers; w++ {
		writersWG.Add(1)
		go func() {
			defer writersWG.Done()
			for i := 0; i < iters; i++ {
				errCh <- agent.RecordOutcome(context.Background(), sampleOutcome())
			}
		}()
	}

	writersWG.Wait()
	close(stop)
	readers.Wait()
	close(errCh)

	// #then
	for err := range errCh {
		if err != nil {
			return fmt.Errorf("RecordOutcome error: %w", err)
		}
	}
	if got := agent.GetHistoryCount(); got != writers*iters {
		return fmt.Errorf("history count = %d, want %d", got, writers*iters)
	}
	return nil
}

// TestRecordOutcomePersistsToFile checks the recorded outcome reaches disk
// with derived fields (accuracy/success) populated.
func TestRecordOutcomePersistsToFile(t *testing.T) {
	// #given
	agent := newTestLearningAgent(t)

	// #when
	if err := agent.RecordOutcome(context.Background(), sampleOutcome()); err != nil {
		t.Fatalf("RecordOutcome: %v", err)
	}

	// #then
	history := agent.GetHistory()
	if len(history) != 1 {
		t.Fatalf("history length = %d, want 1", len(history))
	}
	got := history[0]
	if !got.Success {
		t.Errorf("expected Success=true for a successful outcome")
	}
	// 1 - |100-80|/100 = 0.8
	if got.Accuracy < 0.79 || got.Accuracy > 0.81 {
		t.Errorf("accuracy = %v, want ~0.8", got.Accuracy)
	}
}
