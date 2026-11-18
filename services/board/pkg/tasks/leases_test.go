package tasks_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"open-board/pkg/tasks"
)

func TestNormalizeLease(t *testing.T) {
	cases := map[int]int{
		0:     tasks.DefaultLeaseSeconds,
		-5:    tasks.DefaultLeaseSeconds,
		1:     tasks.MinLeaseSeconds,
		300:   300,
		99999: tasks.MaxLeaseSeconds,
	}
	for in, want := range cases {
		if got := tasks.NormalizeLease(in); got != want {
			t.Fatalf("NormalizeLease(%d) = %d, want %d", in, got, want)
		}
	}
}

func TestReaperReclaimsEveryChannel(t *testing.T) {
	var reaped int32
	var notified int32
	var finished = make(chan struct{})

	r := &tasks.Reaper{
		Interval: 5 * time.Millisecond,
		Channels: func() []string { return []string{"alpha", "beta", "broken"} },
		Reap: func(channel string) (int64, error) {
			if channel == "broken" {
				return 0, context.DeadlineExceeded
			}
			atomic.AddInt32(&reaped, 1)
			if channel == "beta" {
				return 2, nil
			}
			return 0, nil
		},
		OnReclaim: func(channel string, n int64) {
			if channel != "beta" || n != 2 {
				t.Errorf("unexpected reclaim callback: %s %d", channel, n)
			}
			if atomic.AddInt32(&notified, 1) == 1 {
				close(finished)
			}
		},
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go r.Run(ctx)

	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("the reaper never reclaimed a task")
	}
	cancel()
	if atomic.LoadInt32(&reaped) == 0 {
		t.Fatal("the reaper never ran")
	}
}
