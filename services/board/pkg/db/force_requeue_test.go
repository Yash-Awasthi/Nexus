package db

import "testing"

func TestForceRequeueTaskTakesWorkFromAnAgent(t *testing.T) {
	d, err := Open(t.TempDir(), "default")
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	if _, err := d.CreateTask("T1", "default", "s", "one", "locks.Manager", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := d.ClaimTask("T1", "stuck", 300); err != nil {
		t.Fatal(err)
	}
	if _, err := d.SetTaskState("T1", "stuck", StateWorking); err != nil {
		t.Fatal(err)
	}

	task, err := d.ForceRequeueTask("T1")
	if err != nil {
		t.Fatal(err)
	}
	if task.State != StateQueued || task.Owner != nil || task.LeaseUntil != nil {
		t.Fatalf("task still carries an owner or lease: %+v", task)
	}
	if task.ContractInterface != "locks.Manager" {
		t.Fatalf("the contract must survive a requeue: %+v", task)
	}

	// The task is claimable again, and an unknown id is a clean not-found.
	if _, err := d.ClaimTask("T1", "next", 300); err != nil {
		t.Fatalf("requeued task should be claimable: %v", err)
	}
	if _, err := d.ForceRequeueTask("missing"); err != ErrTaskNotFound {
		t.Fatalf("want ErrTaskNotFound, got %v", err)
	}
}
