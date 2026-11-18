package grammar

import "testing"

// BenchmarkParse measures the zero-allocation core with caller-provided
// result and mention buffers (the v3 "zero allocation" target).
func BenchmarkParse(b *testing.B) {
	input := "ask: @claude please check the parser in pkg/grammar/parser.go and report back"
	var msg ParsedMessage
	var buf [16]string
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if err := ParseAndValidateInto(input, &msg, buf[:0]); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkParseWrapper measures the allocating convenience wrapper, which
// allocates only its result value.
func BenchmarkParseWrapper(b *testing.B) {
	input := "ask: @claude please check the parser in pkg/grammar/parser.go and report back"
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := ParseAndValidate(input); err != nil {
			b.Fatal(err)
		}
	}
}
