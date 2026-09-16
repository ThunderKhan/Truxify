package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"
)

// RaftSnapshot is the compacted state-machine snapshot: the last recorded
// command per order as of Index, together with the term of the last included
// entry. It lets a follower that falls behind the retained log prefix catch up
// without re-receiving the whole history.
type RaftSnapshot struct {
	Index uint64            `json:"index"`
	Term  uint64            `json:"term"`
	State map[string]string `json:"state"`
}

// InstallSnapshotRequest is the Raft InstallSnapshot RPC payload.
type InstallSnapshotRequest struct {
	Term          uint64            `json:"term"`
	LeaderID      string            `json:"leader_id"`
	SnapshotIndex uint64            `json:"snapshot_index"`
	SnapshotTerm  uint64            `json:"snapshot_term"`
	State         map[string]string `json:"state"`
}

// InstallSnapshotResponse is the Raft InstallSnapshot RPC result.
type InstallSnapshotResponse struct {
	Term    uint64 `json:"term"`
	Success bool   `json:"success"`
}

// logTermAtLocked returns the term of the entry at the given log index,
// consulting the snapshot boundary when the index is compacted away.
func (rn *RaftNode) logTermAtLocked(index uint64) uint64 {
	if index <= rn.snapshotIndex {
		return rn.snapshotTerm
	}
	return rn.Log[index-rn.snapshotIndex-1].Term
}

// maybeSnapshotLocked folds committed-and-applied entries into a snapshot,
// truncates the log, and persists the snapshot when a snapshot path is
// configured. It must be called with rn.mu held.
func (rn *RaftNode) maybeSnapshotLocked() {
	if rn.CommitIndex < rn.snapshotIndex+rn.compactionThreshold {
		return
	}
	state := make(map[string]string, len(rn.snapshotState))
	for k, v := range rn.snapshotState {
		state[k] = v
	}
	cut := 0
	for cut < len(rn.Log) && rn.Log[cut].Index <= rn.CommitIndex {
		state[rn.Log[cut].OrderID] = rn.Log[cut].Command
		cut++
	}
	// Capture the term of the last folded entry before the boundary moves.
	snapshotTerm := rn.logTermAtLocked(rn.CommitIndex)
	rn.snapshotIndex = rn.CommitIndex
	rn.snapshotTerm = snapshotTerm
	rn.snapshotState = state
	rn.Log = rn.Log[cut:]
	if rn.snapshotPath != "" {
		if err := rn.persistSnapshotLocked(RaftSnapshot{Index: rn.snapshotIndex, Term: rn.snapshotTerm, State: state}); err != nil {
			log.Printf("⚠️ node [%s] failed to persist snapshot at index %d: %v", rn.NodeID, rn.snapshotIndex, err)
		}
	}
	log.Printf("💽 node [%s] compacted log into snapshot at index %d (term %d), retained %d entries", rn.NodeID, rn.snapshotIndex, rn.snapshotTerm, len(rn.Log))
}

// persistSnapshotLocked writes the snapshot atomically (temp file + rename).
func (rn *RaftNode) persistSnapshotLocked(snap RaftSnapshot) error {
	if rn.snapshotPath == "" {
		return nil
	}
	data, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	tmp := rn.snapshotPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, rn.snapshotPath)
}

// loadSnapshotLocked loads snapshot metadata/state and reconciles any log that
// was already recovered from the WAL. The snapshot owns the log prefix through
// SnapshotIndex, so only entries after that boundary may remain in rn.Log.
func (rn *RaftNode) loadSnapshotLocked(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			rn.snapshotPath = path
			return nil
		}
		return err
	}

	var snap RaftSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return err
	}
	if snap.State == nil {
		snap.State = make(map[string]string)
	}

	trim := 0
	for trim < len(rn.Log) && rn.Log[trim].Index <= snap.Index {
		trim++
	}
	if trim > 0 {
		rn.Log = rn.Log[trim:]
	}
	if len(rn.Log) > 0 && rn.Log[0].Index != snap.Index+1 {
		return fmt.Errorf("raft snapshot index %d is incompatible with recovered log starting at index %d", snap.Index, rn.Log[0].Index)
	}

	rn.snapshotPath = path
	rn.snapshotIndex = snap.Index
	rn.snapshotTerm = snap.Term
	rn.snapshotState = snap.State
	if rn.CommitIndex < snap.Index {
		rn.CommitIndex = snap.Index
	}
	if rn.LastApplied < snap.Index {
		rn.LastApplied = snap.Index
	}
	return nil
}

// loadSnapshot reads a previously persisted snapshot so recovery is bounded by
// the snapshot plus the small retained log delta. When a WAL has already been
// replayed, the recovered prefix is reconciled against the snapshot boundary.
func (rn *RaftNode) loadSnapshot(path string) error {
	rn.mu.Lock()
	defer rn.mu.Unlock()
	return rn.loadSnapshotLocked(path)
}

// HandleSnapshot implements the Raft InstallSnapshot RPC for followers that
// fell behind the leader's retained log prefix.
func (rn *RaftNode) HandleSnapshot(w http.ResponseWriter, r *http.Request) {
	if !requireAuth(w, r) {
		return
	}

	var req InstallSnapshotRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	rn.mu.Lock()
	defer rn.mu.Unlock()

	resp := InstallSnapshotResponse{Term: rn.CurrentTerm, Success: false}

	if req.Term > rn.CurrentTerm {
		rn.stepDownLocked(req.Term)
	}

	if req.Term == rn.CurrentTerm {
		rn.Role = Follower
		rn.LeaderID = req.LeaderID
		if rn.VotedFor == "" || rn.VotedFor == req.LeaderID {
			rn.VotedFor = req.LeaderID
		}
		rn.lastLeaderSeen = time.Now()

		if req.SnapshotIndex >= rn.snapshotIndex {
			if req.SnapshotIndex > rn.snapshotIndex {
				state := make(map[string]string, len(req.State))
				for k, v := range req.State {
					state[k] = v
				}
				cut := 0
				for cut < len(rn.Log) && rn.Log[cut].Index <= req.SnapshotIndex {
					cut++
				}
				rn.Log = rn.Log[cut:]
				rn.snapshotIndex = req.SnapshotIndex
				rn.snapshotTerm = req.SnapshotTerm
				rn.snapshotState = state
				if rn.CommitIndex < req.SnapshotIndex {
					rn.CommitIndex = req.SnapshotIndex
					rn.LastApplied = req.SnapshotIndex
				}
				if rn.snapshotPath != "" {
					if err := rn.persistSnapshotLocked(RaftSnapshot{Index: req.SnapshotIndex, Term: req.SnapshotTerm, State: state}); err != nil {
						log.Printf("⚠️ node [%s] failed to persist received snapshot at index %d: %v", rn.NodeID, req.SnapshotIndex, err)
					}
				}
			}
			resp.Success = true
		}
	}

	resp.Term = rn.CurrentTerm

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
