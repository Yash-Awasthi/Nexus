// Package web holds the inspector's single-file UI, embedded in the binary.
package web

import _ "embed"

// IndexHTML is the inspector page served by `vb serve` at /.
//
//go:embed index.html
var IndexHTML []byte
