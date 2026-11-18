// Package tasks holds the lease policy and the reaper that returns abandoned
// work to the queue.
package tasks

import (
	"context"
	"time"
)

// Lease bounds, from the shared board protocol.
const (
	DefaultLeaseSeconds = 300
	MinLeaseSeconds     = 30
	MaxLeaseSeconds     = 3600
)

// ReapInterval is how often the broker looks for abandoned leases.
const ReapInterval = 10 * time.Second

// NormalizeLease clamps a requested lease into the permitted range.
func NormalizeLease(seconds int) int {
	if seconds <= 0 {
		return DefaultLeaseSeconds
	}
	if seconds < MinLeaseSeconds {
		return MinLeaseSeconds
	}
	if seconds > MaxLeaseSeconds {
		return MaxLeaseSeconds
	}
	return seconds
}

// Reaper periodically reclaims tasks whose lease ran out.
type Reaper struct {
	// Channels lists the channels to reap.
	Channels func() []string
	// Reap returns how many tasks a channel reclaimed.
	Reap func(channel string) (int64, error)
	// OnReclaim is called after a channel reclaimed one or more tasks.
	OnReclaim func(channel string, n int64)
	// Interval overrides ReapInterval when set.
	Interval time.Duration
}

// Run reaps until ctx is cancelled.
func (r *Reaper) Run(ctx context.Context) {
	interval := r.Interval
	if interval <= 0 {
		interval = ReapInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.Tick()
		}
	}
}

// Tick reaps every channel once.
func (r *Reaper) Tick() {
	if r.Channels == nil || r.Reap == nil {
		return
	}
	for _, ch := range r.Channels() {
		n, err := r.Reap(ch)
		if err == nil && n > 0 && r.OnReclaim != nil {
			r.OnReclaim(ch, n)
		}
	}
}
