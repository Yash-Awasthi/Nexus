//go:build !windows

package agents

import (
	"os"
	"syscall"
)

// Alive reports whether pid names a running process.
func Alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}
