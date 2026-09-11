package server

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	workerHeartbeatStaleAfter  = 90 * time.Second
	lifecycleHeartbeatInterval = 30 * time.Second
	lifecycleCleanupInterval   = 6 * time.Hour
)

type workerHealthStatus struct {
	LastHeartbeat time.Time
	LastError     string
	LastPersist   time.Time
	Started       bool
}

type workerHealthView struct {
	Name               string    `json:"name"`
	Healthy            bool      `json:"healthy"`
	Started            bool      `json:"started"`
	LastHeartbeat      time.Time `json:"lastHeartbeat,omitempty"`
	HeartbeatAgeSecond int64     `json:"heartbeatAgeSeconds"`
	// LastError is intentionally not serialized: this public liveness endpoint
	// must not disclose provider, database, or filesystem details.
	LastError string `json:"-"`
}

// workerHealthAdminView contains the diagnostic fields that are intentionally
// omitted from the public liveness endpoint. Keep this separate from
// workerHealthView so provider/database errors are never exposed publicly.
type workerHealthAdminView struct {
	Name               string    `json:"name"`
	WorkerName         string    `json:"-"`
	InstanceID         string    `json:"instanceId,omitempty"`
	Healthy            bool      `json:"healthy"`
	Started            bool      `json:"started"`
	LastHeartbeat      time.Time `json:"lastHeartbeat,omitempty"`
	HeartbeatAgeSecond int64     `json:"heartbeatAgeSeconds"`
	LastError          string    `json:"lastError,omitempty"`
}

func (a *App) markWorkerStarted(name string) {
	name = strings.TrimSpace(name)
	if name == "" {
		return
	}
	a.workerHealthMu.Lock()
	status := a.workerHealth[name]
	status.Started = true
	status.LastHeartbeat = time.Now().UTC()
	a.workerHealth[name] = status
	a.workerHealthMu.Unlock()
	a.persistWorkerHeartbeat(name, "")
}

func (a *App) markWorkerHeartbeat(name string) {
	name = strings.TrimSpace(name)
	if name == "" {
		return
	}
	now := time.Now().UTC()
	a.workerHealthMu.Lock()
	status := a.workerHealth[name]
	status.Started = true
	status.LastHeartbeat = now
	persist := status.LastPersist.IsZero() || now.Sub(status.LastPersist) >= 15*time.Second
	if persist {
		status.LastPersist = now
	}
	a.workerHealth[name] = status
	a.workerHealthMu.Unlock()
	if persist {
		a.persistWorkerHeartbeat(name, "")
	}
}

func (a *App) markWorkerError(name string, workerErr error) {
	if workerErr == nil {
		return
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return
	}
	a.workerHealthMu.Lock()
	status := a.workerHealth[name]
	status.LastError = workerErr.Error()
	a.workerHealth[name] = status
	a.workerHealthMu.Unlock()
	a.persistWorkerHeartbeat(name, workerErr.Error())
}

func (a *App) persistWorkerHeartbeat(name, lastError string) {
	if a == nil || a.DB == nil {
		return
	}
	instanceID := a.instanceID
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if _, err := a.DB.ExecContext(ctx, `INSERT INTO worker_heartbeats (worker_name, instance_id, heartbeat_at, last_error) VALUES ($1, $2, now(), $3) ON CONFLICT (worker_name, instance_id) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at, last_error = EXCLUDED.last_error`, name, instanceID, truncateWorkerError(lastError)); err != nil {
			// Migrations may not have run while a process is booting. Health is
			// still available in memory, so do not turn a heartbeat write failure
			// into a worker failure.
			slog.Debug("worker heartbeat persistence failed", "worker", name, "error", err)
		}
	}()
}

func truncateWorkerError(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 1000 {
		return value[:1000]
	}
	return value
}

func (a *App) workerHealthViews() []workerHealthView {
	now := time.Now().UTC()
	a.workerHealthMu.RLock()
	views := make([]workerHealthView, 0, len(a.workerHealth))
	for name, status := range a.workerHealth {
		age := int64(-1)
		healthy := false
		if !status.LastHeartbeat.IsZero() {
			age = maxInt64(0, int64(now.Sub(status.LastHeartbeat).Seconds()))
			healthy = status.Started && now.Sub(status.LastHeartbeat) <= workerHeartbeatStaleAfter
		}
		views = append(views, workerHealthView{Name: name, Healthy: healthy, Started: status.Started, LastHeartbeat: status.LastHeartbeat, HeartbeatAgeSecond: age, LastError: truncateWorkerError(status.LastError)})
	}
	a.workerHealthMu.RUnlock()
	sort.Slice(views, func(i, j int) bool { return views[i].Name < views[j].Name })
	return views
}

func (a *App) workerHealthAdminViews() []workerHealthAdminView {
	now := time.Now().UTC()
	a.workerHealthMu.RLock()
	views := make([]workerHealthAdminView, 0, len(a.workerHealth))
	for name, status := range a.workerHealth {
		age := int64(-1)
		healthy := false
		if !status.LastHeartbeat.IsZero() {
			age = maxInt64(0, int64(now.Sub(status.LastHeartbeat).Seconds()))
			healthy = status.Started && now.Sub(status.LastHeartbeat) <= workerHeartbeatStaleAfter
		}
		views = append(views, workerHealthAdminView{Name: name, WorkerName: name, Healthy: healthy, Started: status.Started, LastHeartbeat: status.LastHeartbeat, HeartbeatAgeSecond: age, LastError: truncateWorkerError(status.LastError)})
	}
	a.workerHealthMu.RUnlock()
	sort.Slice(views, func(i, j int) bool { return views[i].Name < views[j].Name })
	return views
}

// workerHealthAdminViewsFromDB includes heartbeats from every backend replica.
// The in-memory view is still used as a fallback while migrations are rolling
// out or before the first asynchronous heartbeat write completes.
func (a *App) workerHealthAdminViewsFromDB(ctx context.Context) ([]workerHealthAdminView, error) {
	if a == nil || a.DB == nil {
		return nil, nil
	}
	rows, err := a.DB.QueryContext(ctx, `SELECT worker_name, instance_id, heartbeat_at, last_error FROM worker_heartbeats ORDER BY worker_name, heartbeat_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	now := time.Now().UTC()
	views := []workerHealthAdminView{}
	for rows.Next() {
		var workerName, instanceID, lastError string
		var heartbeatAt time.Time
		if err := rows.Scan(&workerName, &instanceID, &heartbeatAt, &lastError); err != nil {
			return nil, err
		}
		age := maxInt64(0, int64(now.Sub(heartbeatAt).Seconds()))
		views = append(views, workerHealthAdminView{
			Name:               workerName,
			WorkerName:         workerName,
			InstanceID:         instanceID,
			Healthy:            now.Sub(heartbeatAt) <= workerHeartbeatStaleAfter,
			Started:            true,
			LastHeartbeat:      heartbeatAt,
			HeartbeatAgeSecond: age,
			LastError:          truncateWorkerError(lastError),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return views, nil
}

func (a *App) workersReady() bool {
	a.workerHealthMu.RLock()
	defer a.workerHealthMu.RUnlock()
	started := false
	now := time.Now().UTC()
	for _, status := range a.workerHealth {
		if !status.Started {
			continue
		}
		started = true
		if status.LastHeartbeat.IsZero() || now.Sub(status.LastHeartbeat) > workerHeartbeatStaleAfter {
			return false
		}
	}
	// Apps created directly by unit tests do not start workers. Preserve the
	// previous readiness semantics until a worker has actually been started.
	return !started || len(a.workerHealth) > 0
}

func (a *App) workerHealthHandler(c *gin.Context) {
	views := a.workerHealthViews()
	ready := a.workersReady()
	status := http.StatusOK
	if !ready {
		status = http.StatusServiceUnavailable
	}
	c.JSON(status, gin.H{"status": map[bool]string{true: "ready", false: "not_ready"}[ready], "workers": views, "instanceId": a.instanceID})
}

func (a *App) metricsHandler(c *gin.Context) {
	views := a.workerHealthViews()
	var builder strings.Builder
	builder.WriteString("# HELP justai_worker_healthy Whether a backend worker heartbeat is fresh.\n# TYPE justai_worker_healthy gauge\n")
	for _, view := range views {
		fmt.Fprintf(&builder, "justai_worker_healthy{worker=%q} %d\n", view.Name, boolMetric(view.Healthy))
	}
	builder.WriteString("# HELP justai_worker_heartbeat_age_seconds Seconds since the last worker heartbeat.\n# TYPE justai_worker_heartbeat_age_seconds gauge\n")
	for _, view := range views {
		age := view.HeartbeatAgeSecond
		if age < 0 {
			age = 0
		}
		fmt.Fprintf(&builder, "justai_worker_heartbeat_age_seconds{worker=%q} %d\n", view.Name, age)
	}
	c.Data(http.StatusOK, "text/plain; version=0.0.4", []byte(builder.String()))
}

func boolMetric(value bool) int {
	if value {
		return 1
	}
	return 0
}
