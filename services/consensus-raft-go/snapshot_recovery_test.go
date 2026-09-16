package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeTestWAL(t *testing.T, path string, entries []LogEntry) {
	t.Helper()
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("create WAL: %v", err)
	}
	defer file.Close()

	for i := range entries {
		entry := entries[i]
		record, err := json.Marshal(raftWALRecord{Type: recordEntry, Entry: &entry})
		if err != nil {
			t.Fatalf("marshal WAL entry: %v", err)
		}
		if _, err := file.Write(append(record, '\n')); err != nil {
			t.Fatalf("write WAL entry: %v", err)
		}
	}
}

func writeTestSnapshot(t *testing.T, path string, snapshot RaftSnapshot) {
	t.Helper()
	data, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write snapshot: %v", err)
	}
}

func TestLoadSnapshotReconcilesRecoveredLog(t *testing.T) {
	dir := t.TempDir()
	snapshotPath := filepath.Join(dir, "raft-snapshot.json")
	snapshot := RaftSnapshot{
		Index: 5,
		Term:  3,
		State: map[string]string{"ord-1": "COMPLETED"},
	}
	writeTestSnapshot(t, snapshotPath, snapshot)

	node := NewRaftNode("node1", nil, nil)
	node.Log = []LogEntry{
		{Index: 1, Term: 1, Command: "CREATED", OrderID: "ord-1"},
		{Index: 2, Term: 1, Command: "DISPATCHED", OrderID: "ord-1"},
		{Index: 3, Term: 2, Command: "IN_TRANSIT", OrderID: "ord-1"},
		{Index: 4, Term: 2, Command: "DELIVERED", OrderID: "ord-1"},
		{Index: 5, Term: 3, Command: "COMPLETED", OrderID: "ord-1"},
		{Index: 6, Term: 4, Command: "CREATED", OrderID: "ord-2"},
	}
	node.CommitIndex = 2
	node.LastApplied = 2

	if err := node.loadSnapshot(snapshotPath); err != nil {
		t.Fatalf("load snapshot: %v", err)
	}

	if node.snapshotIndex != 5 || node.snapshotTerm != 3 {
		t.Fatalf("unexpected snapshot metadata: index=%d term=%d", node.snapshotIndex, node.snapshotTerm)
	}
	if node.CommitIndex != 5 || node.LastApplied != 5 {
		t.Fatalf("expected commit/apply indexes to advance to snapshot boundary: commit=%d applied=%d", node.CommitIndex, node.LastApplied)
	}
	if len(node.Log) != 1 || node.Log[0].Index != 6 {
		t.Fatalf("expected only post-snapshot entry to remain, got %#v", node.Log)
	}
	if node.lastLogIndex() != 6 {
		t.Fatalf("expected canonical last log index 6, got %d", node.lastLogIndex())
	}
	if node.lastLogTerm() != 4 {
		t.Fatalf("expected last log term 4, got %d", node.lastLogTerm())
	}
}

func TestRecoverFromWALReconcilesLoadedSnapshot(t *testing.T) {
	dir := t.TempDir()
	walPath := filepath.Join(dir, "raft-state.wal")
	snapshotPath := filepath.Join(dir, "raft-snapshot.json")

	entries := []LogEntry{
		{Index: 1, Term: 1, Command: "CREATED", OrderID: "ord-1", Timestamp: time.Unix(1, 0)},
		{Index: 2, Term: 1, Command: "DISPATCHED", OrderID: "ord-1", Timestamp: time.Unix(2, 0)},
		{Index: 3, Term: 2, Command: "IN_TRANSIT", OrderID: "ord-1", Timestamp: time.Unix(3, 0)},
		{Index: 4, Term: 2, Command: "DELIVERED", OrderID: "ord-1", Timestamp: time.Unix(4, 0)},
		{Index: 5, Term: 3, Command: "COMPLETED", OrderID: "ord-1", Timestamp: time.Unix(5, 0)},
		{Index: 6, Term: 4, Command: "CREATED", OrderID: "ord-2", Timestamp: time.Unix(6, 0)},
		{Index: 7, Term: 4, Command: "DISPATCHED", OrderID: "ord-2", Timestamp: time.Unix(7, 0)},
	}
	writeTestWAL(t, walPath, entries)
	writeTestSnapshot(t, snapshotPath, RaftSnapshot{
		Index: 5,
		Term:  3,
		State: map[string]string{"ord-1": "COMPLETED"},
	})
	t.Setenv("RAFT_SNAPSHOT_PATH", snapshotPath)

	node := NewRaftNode("node1", nil, nil)
	if err := node.recoverFromWAL(walPath); err != nil {
		t.Fatalf("recover WAL: %v", err)
	}
	defer node.Close()

	if node.snapshotIndex != 5 || node.snapshotTerm != 3 {
		t.Fatalf("snapshot metadata not restored: index=%d term=%d", node.snapshotIndex, node.snapshotTerm)
	}
	if len(node.Log) != 2 || node.Log[0].Index != 6 || node.Log[1].Index != 7 {
		t.Fatalf("expected WAL suffix 6..7 after reconciliation, got %#v", node.Log)
	}
	if node.lastLogIndex() != 7 {
		t.Fatalf("expected last log index 7 after reconciliation, got %d", node.lastLogIndex())
	}
	if node.Log[0].Index == 1 {
		t.Fatal("recovered compacted WAL prefix was not trimmed")
	}
}

func TestLoadSnapshotRejectsNonContiguousRecoveredSuffix(t *testing.T) {
	dir := t.TempDir()
	snapshotPath := filepath.Join(dir, "raft-snapshot.json")
	writeTestSnapshot(t, snapshotPath, RaftSnapshot{
		Index: 5,
		Term:  3,
		State: map[string]string{},
	})

	node := NewRaftNode("node1", nil, nil)
	node.Log = []LogEntry{{Index: 7, Term: 4, Command: "CREATED", OrderID: "ord-2"}}

	if err := node.loadSnapshot(snapshotPath); err == nil {
		t.Fatal("expected non-contiguous recovered suffix to be rejected")
	}
}
