package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// raftRecordType identifies a record in the append-only WAL.
type raftRecordType string

const (
	// recordTerm persists a currentTerm change together with the vote cast in
	// that term ("" when no vote has been cast yet).
	recordTerm raftRecordType = "term"
	// recordEntry persists a single log entry.
	recordEntry raftRecordType = "entry"
)

// raftWALRecord is a single JSON line in the append-only state file.
type raftWALRecord struct {
	Type     raftRecordType `json:"type"`
	Term     uint64         `json:"term,omitempty"`
	VotedFor *string        `json:"voted_for,omitempty"`
	Entry    *LogEntry      `json:"entry,omitempty"`
}

// recoverFromWAL opens (creating if needed) the append-only state file at path,
// replays the persisted currentTerm, votedFor, and log, and wires subsequent
// mutations to the same file. It must run before run() starts so the node never
// campaigns or votes with a term lower than the persisted one (Raft §3.5).
func (rn *RaftNode) recoverFromWAL(path string) error {
	rn.mu.Lock()
	defer rn.mu.Unlock()

	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}

	rn.Log = make([]LogEntry, 0, len(rn.Log))
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 64*1024)
	line := 0
	for scanner.Scan() {
		line++
		raw := scanner.Bytes()
		if len(strings.TrimSpace(string(raw))) == 0 {
			continue
		}
		var rec raftWALRecord
		if err := json.Unmarshal(raw, &rec); err != nil {
			file.Close()
			return fmt.Errorf("raft state file %s: invalid record on line %d: %w", path, line, err)
		}
		switch rec.Type {
		case recordTerm:
			rn.CurrentTerm = rec.Term
			if rec.VotedFor != nil {
				rn.VotedFor = *rec.VotedFor
			} else {
				rn.VotedFor = ""
			}
		case recordEntry:
			if rec.Entry == nil || rec.Entry.Index == 0 {
				file.Close()
				return fmt.Errorf("raft state file %s: invalid entry record on line %d", path, line)
			}
			idx := int(rec.Entry.Index)
			// Later records overwrite earlier ones at the same index (log
			// conflict resolution in appendLogFromLeaderLocked), so a stale
			// entry followed by a replacement must not both survive replay.
			if idx <= len(rn.Log) {
				rn.Log = rn.Log[:idx-1]
			}
			rn.Log = append(rn.Log, *rec.Entry)
		default:
			file.Close()
			return fmt.Errorf("raft state file %s: unknown record type %q on line %d", path, rec.Type, line)
		}
	}
	if err := scanner.Err(); err != nil {
		file.Close()
		return err
	}

	// The snapshot owns the compacted log prefix. Apply it after WAL replay so
	// the recovered log is reduced to the suffix that remains authoritative.
	if snapshotPath := os.Getenv("RAFT_SNAPSHOT_PATH"); snapshotPath != "" {
		if err := rn.loadSnapshotLocked(snapshotPath); err != nil {
			file.Close()
			return err
		}
	}

	rn.wal = file
	rn.storePath = path
	return nil
}

// Close flushes and releases the raft state file. It is safe to call on a node
// whose persistence is disabled.
func (rn *RaftNode) Close() error {
	rn.mu.Lock()
	defer rn.mu.Unlock()
	if rn.wal == nil {
		return nil
	}
	err := rn.wal.Close()
	rn.wal = nil
	return err
}

// persistTermLocked durably records the current term and the vote decision made
// in it. It must be called with rn.mu held, before any acknowledgment that
// depends on the new term (Raft §3.5).
func (rn *RaftNode) persistTermLocked(term uint64, votedFor string) error {
	if rn.wal == nil {
		return nil
	}
	v := votedFor
	return rn.appendWALLocked(raftWALRecord{Type: recordTerm, Term: term, VotedFor: &v})
}

// persistEntriesLocked durably appends log entries to the state file. It must
// be called with rn.mu held, before an entry is acknowledged as replicated.
func (rn *RaftNode) persistEntriesLocked(entries []LogEntry) error {
	if rn.wal == nil {
		return nil
	}
	for i := range entries {
		e := entries[i]
		if err := rn.appendWALLocked(raftWALRecord{Type: recordEntry, Entry: &e}); err != nil {
			return err
		}
	}
	return nil
}

// appendWALLocked writes one JSON record and fsyncs it so the write is durable
// before the caller returns any acknowledgment.
func (rn *RaftNode) appendWALLocked(rec raftWALRecord) error {
	data, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if _, err := rn.wal.Write(data); err != nil {
		return err
	}
	return rn.wal.Sync()
}
