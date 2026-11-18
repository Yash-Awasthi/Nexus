//go:build !windows

package agents

import (
	"fmt"
	"os"
)

func terminateProcess(pid int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return fmt.Errorf("terminate pid %d: %w", pid, err)
	}
	if err := p.Kill(); err != nil {
		return fmt.Errorf("terminate pid %d: %w", pid, err)
	}
	return nil
}
