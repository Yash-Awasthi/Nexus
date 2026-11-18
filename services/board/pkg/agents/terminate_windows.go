//go:build windows

package agents

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// terminateProcess ends a Windows process tree; taskkill /T covers agents that
// spawn their own shells and children.
func terminateProcess(pid int) error {
	out, err := exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F").CombinedOutput()
	if err != nil {
		return fmt.Errorf("terminate pid %d: %v: %s", pid, err, strings.TrimSpace(string(out)))
	}
	return nil
}
