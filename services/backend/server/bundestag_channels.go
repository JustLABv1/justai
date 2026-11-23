package server

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"justai-backend/provider"
	"justai-backend/streamrelay"
)

// The Bundestag broadcasts plenary sessions on channel 1 and committee sessions on
// further Parlamentsfernsehen channels. Its programme names the channel of every
// session, so users pick a session and JustAI picks the matching stream:
//
//   - the Bundestag live page uses the channel's public HLS audio, except channel 1,
//     which keeps the plenary radio stream the resolver already uses;
//   - a relay source is swapped for the relay's source "bundestag-hk<N>" (for channel
//     1 also "bundestag"), the naming documented in deploy/stream-relay/README.md.
const (
	maxBundestagChannel        = 32
	bundestagChannelHLSPattern = "https://bttv-live-z.r53.cdn.tv1.eu/13014bundestag-hk%d/live_or_128/playlist_dvr.m3u8"
)

// bundestagRelaySourceIDs lists the relay source IDs that carry a channel, preferred first.
func bundestagRelaySourceIDs(channel int) []string {
	ids := []string{fmt.Sprintf("bundestag-hk%d", channel)}
	if channel == 1 {
		ids = append(ids, "bundestag")
	}
	return ids
}

// bundestagChannelURL returns the stream that carries channel for a source set up
// with streamURL. ok is false when that source family has no stream for the channel.
// URLs outside the Bundestag family, and an unknown channel, are returned unchanged.
func bundestagChannelURL(streamURL string, channel int, relaySources []streamrelay.Source) (string, bool) {
	if channel <= 0 || channel > maxBundestagChannel || !isBundestagPlanURL(streamURL) {
		return streamURL, true
	}
	if isBundestagLiveURL(streamURL) {
		if channel == 1 {
			return streamURL, true
		}
		return fmt.Sprintf(bundestagChannelHLSPattern, channel), true
	}
	id, ok := streamrelay.RelaySourceID(streamURL)
	if !ok {
		return streamURL, true
	}
	prefix := strings.TrimSuffix(strings.TrimSpace(streamURL), "/v1/sources/"+id)
	for _, want := range bundestagRelaySourceIDs(channel) {
		target := prefix + "/v1/sources/" + want
		for _, source := range relaySources {
			if strings.EqualFold(source.URL, target) {
				return source.URL, true
			}
		}
	}
	return "", false
}

// relaySourcesFor lists the relay's sources when streamURL is a relay source.
func relaySourcesFor(ctx context.Context, streamURL string) ([]streamrelay.Source, error) {
	if _, ok := streamrelay.RelaySourceID(streamURL); !ok {
		return nil, nil
	}
	list, err := streamRelaySourceCache.get(ctx)
	if err != nil {
		return nil, err
	}
	return list.Sources, nil
}

// annotatePlanChannels marks which plan sessions the source can reach, so the
// session picker can hide channels the relay does not carry.
func annotatePlanChannels(ctx context.Context, streamURL string, plan []planSession) {
	sources, err := relaySourcesFor(ctx, streamURL)
	if err != nil {
		return
	}
	for i := range plan {
		if plan[i].Channel == 0 {
			continue
		}
		_, ok := bundestagChannelURL(streamURL, plan[i].Channel, sources)
		plan[i].ChannelAvailable = &ok
	}
}

func errChannelUnavailable(session planSession) error {
	return fmt.Errorf("%q is broadcast on Bundestag channel %d, which this stream relay does not provide; add a relay source named %q", session.Title, session.Channel, bundestagRelaySourceIDs(session.Channel)[0])
}

// checkPlanChannel fails when the source cannot reach the channel of a plan session.
func checkPlanChannel(ctx context.Context, streamURL string, session planSession) error {
	sources, err := relaySourcesFor(ctx, streamURL)
	if err != nil {
		return fmt.Errorf("the stream relay sources could not be listed: %w", err)
	}
	if _, ok := bundestagChannelURL(streamURL, session.Channel, sources); !ok {
		return errChannelUnavailable(session)
	}
	return nil
}

// runningBundestagSession picks the session to capture when a Bundestag source starts
// right away: the plenary when it is running, otherwise the only running session.
func runningBundestagSession(plan []planSession, now time.Time) (planSession, bool) {
	var running []planSession
	for _, session := range plan {
		if session.Channel > 0 && !now.Before(session.StartAt.Add(-planWindowLead)) && now.Before(session.EndAt) {
			running = append(running, session)
		}
	}
	for _, session := range running {
		if session.Channel == 1 {
			return session, true
		}
	}
	if len(running) == 1 {
		return running[0], true
	}
	return planSession{}, false
}

// routeBundestagChannel returns the stream to capture for a source: the stream of the
// channel that broadcasts its plan session, or streamURL when no session is attached.
func (m *TranscriptionManager) routeBundestagChannel(ctx context.Context, sourceID uuid.UUID, streamURL string) (string, error) {
	if !isBundestagPlanURL(streamURL) {
		return streamURL, nil
	}
	var planKey string
	if err := m.DB.QueryRowContext(ctx, `SELECT COALESCE(plan_key, '') FROM transcription_stream_sources WHERE source_id = $1`, sourceID).Scan(&planKey); err != nil || planKey == "" {
		return streamURL, nil
	}
	fetchCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	plan, err := cachedBundestagPlan(fetchCtx, provider.SafeHTTPClient(15*time.Second, m.Config.AllowPrivate))
	if err != nil {
		// The session was checked when it was set up; keep the source as configured.
		slog.Warn("bundestag plan unavailable for channel routing", "sourceId", sourceID, "error", err)
		return streamURL, nil
	}
	for _, session := range plan {
		if session.Key != planKey {
			continue
		}
		sources, err := relaySourcesFor(fetchCtx, streamURL)
		if err != nil {
			return "", fmt.Errorf("the stream relay sources could not be listed: %w", err)
		}
		routed, ok := bundestagChannelURL(streamURL, session.Channel, sources)
		if !ok {
			return "", errChannelUnavailable(session)
		}
		return routed, nil
	}
	return streamURL, nil
}

// runningBundestagSessionFor looks up the session on air now; best effort.
func (a *App) runningBundestagSessionFor(ctx context.Context, streamURL string) (planSession, bool) {
	fetchCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	plan, err := cachedBundestagPlan(fetchCtx, provider.SafeHTTPClient(15*time.Second, a.Config.AllowPrivate))
	if err != nil {
		return planSession{}, false
	}
	return runningBundestagSession(plan, time.Now())
}
