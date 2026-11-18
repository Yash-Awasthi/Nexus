package db

import "testing"

func TestRequeueAgentTasksReturnsWorkToTheQueue(t *testing.T) {
	d, err := Open(t.TempDir(), "default")
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	if _, err := d.CreateTask("T1", "default", "s", "one", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := d.CreateTask("T2", "default", "s", "two", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := d.ClaimTask("T1", "crashed", 300); err != nil {
		t.Fatal(err)
	}
	if _, err := d.SetTaskState("T1", "crashed", StateWorking); err != nil {
		t.Fatal(err)
	}
	if _, err := d.ClaimTask("T2", "healthy", 300); err != nil {
		t.Fatal(err)
	}

	requeued, err := d.RequeueAgentTasks("crashed")
	if err != nil {
		t.Fatal(err)
	}
	if len(requeued) != 1 || requeued[0].ID != "T1" {
		t.Fatalf("want T1 requeued, got %+v", requeued)
	}
	if requeued[0].State != StateQueued || requeued[0].Owner != nil || requeued[0].LeaseUntil != nil {
		t.Fatalf("requeued task still carries an owner or lease: %+v", requeued[0])
	}

	t1, err := d.GetTask("T1")
	if err != nil {
		t.Fatal(err)
	}
	if t1.State != StateQueued || t1.Owner != nil {
		t.Fatalf("stored T1 was not requeued: %+v", t1)
	}
	t2, err := d.GetTask("T2")
	if err != nil {
		t.Fatal(err)
	}
	if t2.State != StateClaimed || t2.Owner == nil || *t2.Owner != "healthy" {
		t.Fatalf("another agent's task must be untouched: %+v", t2)
	}

	if requeued, err := d.RequeueAgentTasks(""); err != nil || requeued != nil {
		t.Fatalf("an empty agent is a no-op: %v %v", requeued, err)
	}
}
