package api_test

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"open-board/pkg/api"
)

// benchBroker starts the real handler over an in-process HTTP server. The
// client keeps connections alive, so the numbers measure the broker and not
// process startup.
func benchBroker(b *testing.B) (*httptest.Server, *http.Client) {
	b.Helper()
	store, err := api.NewStore(b.TempDir())
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { store.Close() })
	srv := api.NewServer(store, "default")
	ts := httptest.NewServer(srv.Handler(nil))
	b.Cleanup(ts.Close)

	client := ts.Client()
	if transport, ok := client.Transport.(*http.Transport); ok {
		transport.MaxIdleConns = 128
		transport.MaxIdleConnsPerHost = 128
	}
	return ts, client
}

func benchPost(b *testing.B, client *http.Client, url, body string) {
	resp, err := client.Post(url, "application/json", bytes.NewReader([]byte(body)))
	if err != nil {
		b.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		b.Fatalf("post status = %d", resp.StatusCode)
	}
}

// BenchmarkPostEvent is the events-per-second path: JSON in, validated,
// persisted, broadcast, response out.
func BenchmarkPostEvent(b *testing.B) {
	ts, client := benchBroker(b)
	const payload = `{"thread":"bench","actor":"bench","content":"note: throughput probe"}`
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		benchPost(b, client, ts.URL+"/api/post", payload)
	}
}

// BenchmarkPostEventParallel16 measures the broker with 16 agents posting at
// once (the documented capacity ceiling).
func BenchmarkPostEventParallel16(b *testing.B) {
	ts, client := benchBroker(b)
	const payload = `{"thread":"bench","actor":"bench","content":"note: throughput probe"}`
	const workers = 16
	per := b.N / workers
	if per < 1 {
		per = 1
	}
	b.ReportAllocs()
	b.ResetTimer()
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < per; i++ {
				benchPost(b, client, ts.URL+"/api/post", payload)
			}
		}()
	}
	wg.Wait()
	b.ReportMetric(float64(workers*per)/b.Elapsed().Seconds(), "events/sec")
}
