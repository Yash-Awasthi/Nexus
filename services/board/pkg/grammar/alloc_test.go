package grammar

import "testing"

// TestParseIntoDoesNotAllocate pins the v3 "zero allocation" claim for the
// parser core: a caller that supplies the result and a mention buffer gets a
// parse with no heap traffic on the common lower-case path.
func TestParseIntoDoesNotAllocate(t *testing.T) {
	var msg ParsedMessage
	var buf [16]string
	inputs := []string{
		"ask: @claude please check the parser in pkg/grammar/parser.go",
		"note: plain prose without mentions",
		"done: sprint-1.T2 tests pass",
	}
	for _, input := range inputs {
		allocs := testing.AllocsPerRun(200, func() {
			if err := ParseAndValidateInto(input, &msg, buf[:0]); err != nil {
				t.Fatalf("%q: %v", input, err)
			}
		})
		if allocs != 0 {
			t.Fatalf("%q allocates %.1f times per parse, want 0", input, allocs)
		}
	}
}

func TestParseIntoMatchesTheWrapper(t *testing.T) {
	var buf [16]string
	for _, input := range []string{
		"ask: @claude and @Codex look at this",
		"note: prose only",
		"%*% pkg/api/server.go Handler",
		"done: sprint-1.T1 finished",
	} {
		want, err := ParseAndValidate(input)
		if err != nil {
			t.Fatalf("%q: %v", input, err)
		}
		var got ParsedMessage
		if err := ParseAndValidateInto(input, &got, buf[:0]); err != nil {
			t.Fatalf("%q: %v", input, err)
		}
		if got.Verb != want.Verb || got.Argument != want.Argument || got.Words != want.Words ||
			got.IsSlice != want.IsSlice || got.SlicePath != want.SlicePath || got.SliceTarget != want.SliceTarget {
			t.Fatalf("%q: into=%+v wrapper=%+v", input, got, *want)
		}
		if len(got.Mentions) != len(want.Mentions) {
			t.Fatalf("%q mentions: into=%v wrapper=%v", input, got.Mentions, want.Mentions)
		}
		for i := range got.Mentions {
			if got.Mentions[i] != want.Mentions[i] {
				t.Fatalf("%q mentions: into=%v wrapper=%v", input, got.Mentions, want.Mentions)
			}
		}
	}
}
