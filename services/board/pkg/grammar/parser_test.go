package grammar

import (
	"strings"
	"testing"
)

func TestStatusVerbs(t *testing.T) {
	cases := []struct {
		in   string
		verb string
		arg  string
	}{
		{"claim: T1", "claim", "T1"},
		{"DONE! T1 shipped", "done", "T1 shipped"},
		{"working: T2 on parser", "working", "T2 on parser"},
		{"review-ok: T3", "review-ok", "T3"},
		{"  failed: T4 timeout  ", "failed", "T4 timeout"},
		{"lock: C:\\repo\\src\\db.go", "lock", "C:\\repo\\src\\db.go"},
	}
	for _, c := range cases {
		got, err := ParseAndValidate(c.in)
		if err != nil {
			t.Fatalf("%q: %v", c.in, err)
		}
		if got.Verb != c.verb || got.Argument != c.arg {
			t.Fatalf("%q: got verb=%q arg=%q", c.in, got.Verb, got.Argument)
		}
	}
}

func TestPlainProseIsANote(t *testing.T) {
	got, err := ParseAndValidate("the deploy is green, shipping now")
	if err != nil {
		t.Fatal(err)
	}
	if got.Verb != "note" || got.Argument != "the deploy is green, shipping now" {
		t.Fatalf("unexpected note: %+v", got)
	}
}

func TestBrokenVerbsAndMissingArguments(t *testing.T) {
	for _, in := range []string{"bogus: thing", "**done**: T1"} {
		if _, err := ParseAndValidate(in); err == nil {
			t.Fatalf("%q should be rejected", in)
		}
	}
	for _, in := range []string{"claim", "claim:", "done", "lock:"} {
		if _, err := ParseAndValidate(in); err == nil {
			t.Fatalf("%q should need an argument", in)
		}
	}
	if _, err := ParseAndValidate("   "); err == nil {
		t.Fatal("an empty message should be rejected")
	}
}

func TestWordCap(t *testing.T) {
	ok := "note: " + strings.Repeat("word ", WordCap-2)
	if _, err := ParseAndValidate(ok); err != nil {
		t.Fatalf("a message at the cap should pass: %v", err)
	}
	over := "note: " + strings.Repeat("word ", WordCap)
	if _, err := ParseAndValidate(over); err == nil {
		t.Fatal("a message over the cap should be rejected")
	}
}

func TestSliceBypassesCap(t *testing.T) {
	msg := "%*% pkg/db/sqlite.go ClaimTask " + strings.Repeat("word ", 300)
	got, err := ParseAndValidate(msg)
	if err != nil {
		t.Fatalf("slices are uncapped: %v", err)
	}
	if !got.IsSlice || got.Verb != "slice" {
		t.Fatalf("unexpected slice: %+v", got)
	}
	if got.SlicePath != "pkg/db/sqlite.go" || !strings.HasPrefix(got.SliceTarget, "ClaimTask") {
		t.Fatalf("slice was parsed wrong: %+v", got)
	}
	if _, err := ParseAndValidate("%*%"); err == nil {
		t.Fatal("a slice needs a path")
	}
}

func TestMentions(t *testing.T) {
	got := ExtractMentions("ask: @Alice please check (cc @bob_2, @all) — email me@example.com")
	want := map[string]bool{"@alice": true, "@bob_2": true, "@all": true}
	if len(got) != len(want) {
		t.Fatalf("want %v, got %v", want, got)
	}
	for _, m := range got {
		if !want[m] {
			t.Fatalf("unexpected mention %q in %v", m, got)
		}
	}
	if again := ExtractMentions("@alice @alice"); len(again) != 1 {
		t.Fatalf("mentions should be distinct: %v", again)
	}
}

func TestTaskRef(t *testing.T) {
	if got := TaskRef("T1 shipped the parser"); got != "T1" {
		t.Fatalf("got %q", got)
	}
	if got := TaskRef(""); got != "" {
		t.Fatalf("got %q", got)
	}
}
