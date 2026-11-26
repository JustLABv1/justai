package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"

	"justai-backend/provider"
)

// Reminders let the assistant promise "I'll tell you in 20 minutes": it stores one with
// set_reminder, and JustAI notifies the user when it is due (in the app, by browser push
// and e-mail), linking back to the conversation.

const (
	reminderMaxOpen    = 50
	reminderMaxAhead   = 366 * 24 * time.Hour
	reminderMinAhead   = 30 * time.Second
	reminderMaxMessage = 500
)

func reminderTools() []provider.ToolDefinition {
	return []provider.ToolDefinition{
		{
			Name:        "set_reminder",
			Description: "Remind the user later: JustAI notifies them at the due time in the app, by browser push and by e-mail when they turned those on, with a link back to this chat. Use it when the user asks to be reminded or informed at a time or after a delay (\"in 20 minutes\", \"tomorrow at 9\"). Give inMinutes for a delay, or at for a clock time in the user's local time zone; for another day, add inDays (1 = tomorrow) instead of guessing a date. Write message as the reminder the user will read, in their language. Confirm the returned dueLocal time to the user; do not claim anything else will happen at that time.",
			Parameters:  json.RawMessage(`{"type":"object","properties":{"message":{"type":"string","minLength":1,"maxLength":500,"description":"What to remind the user of, written for them."},"inMinutes":{"type":"number","minimum":1,"maximum":527040,"description":"Delay from now in minutes."},"at":{"type":"string","description":"Local clock time \"HH:MM\" (the next such time, or on the day given by inDays), or a full local \"YYYY-MM-DD HH:MM\"."},"inDays":{"type":"integer","minimum":0,"maximum":366,"description":"With an HH:MM at: 0 for today, 1 for tomorrow, and so on."}},"required":["message"],"additionalProperties":false}`),
		},
		{
			Name:        "list_reminders",
			Description: "List the user's upcoming reminders with their ids and local due times.",
			Parameters:  json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`),
		},
		{
			Name:        "cancel_reminder",
			Description: "Cancel one of the user's upcoming reminders by the id from set_reminder or list_reminders.",
			Parameters:  json.RawMessage(`{"type":"object","properties":{"reminderId":{"type":"string"}},"required":["reminderId"],"additionalProperties":false}`),
		},
	}
}

func isReminderTool(name string) bool {
	return name == "set_reminder" || name == "list_reminders" || name == "cancel_reminder"
}

// userTimeZone is the zone the user's browser reported, else UTC.
func (a *App) userTimeZone(ctx context.Context, userID uuid.UUID) *time.Location {
	var name string
	_ = a.DB.QueryRowContext(ctx, `SELECT timezone FROM notification_settings WHERE user_id = $1`, userID).Scan(&name)
	if location, err := time.LoadLocation(name); err == nil && name != "" {
		return location
	}
	return time.UTC
}

// reminderDue reads inMinutes or at into a moment.
func reminderDue(args map[string]any, now time.Time, location *time.Location) (time.Time, error) {
	if minutes, ok := args["inMinutes"].(float64); ok && minutes > 0 {
		if math.IsNaN(minutes) || minutes > reminderMaxAhead.Minutes() {
			return time.Time{}, fmt.Errorf("inMinutes is out of range")
		}
		return now.Add(time.Duration(minutes * float64(time.Minute))), nil
	}
	at := strings.TrimSpace(stringToolArgument(args, "at"))
	if at == "" {
		return time.Time{}, fmt.Errorf("give inMinutes or at")
	}
	if absolute, err := time.Parse(time.RFC3339, at); err == nil {
		return absolute, nil
	}
	local := now.In(location)
	for _, layout := range []string{"2006-01-02 15:04", "2006-01-02T15:04", "2006-01-02 15:04:05", "2006-01-02T15:04:05"} {
		if parsed, err := time.ParseInLocation(layout, at, location); err == nil {
			return parsed, nil
		}
	}
	if clock, err := time.Parse("15:04", at); err == nil {
		due := time.Date(local.Year(), local.Month(), local.Day(), clock.Hour(), clock.Minute(), 0, 0, location)
		if days, ok := args["inDays"].(float64); ok && days >= 0 && days <= 366 {
			return due.AddDate(0, 0, int(days)), nil
		}
		if !due.After(now) {
			due = due.AddDate(0, 0, 1)
		}
		return due, nil
	}
	return time.Time{}, fmt.Errorf("at must look like 2026-11-27 15:00 or 15:00")
}

func reminderLocal(due time.Time, location *time.Location) string {
	return due.In(location).Format("Mon 2006-01-02 15:04 MST")
}

func (a *App) reminderTool(ctx context.Context, userID, organizationID, conversationID uuid.UUID, name string, args map[string]any) (json.RawMessage, error) {
	location := a.userTimeZone(ctx, userID)
	switch name {
	case "set_reminder":
		message := strings.TrimSpace(stringToolArgument(args, "message"))
		if message == "" || len([]rune(message)) > reminderMaxMessage {
			return nil, fmt.Errorf("message must be 1 to %d characters", reminderMaxMessage)
		}
		now := time.Now()
		due, err := reminderDue(args, now, location)
		if err != nil {
			return nil, err
		}
		if due.Before(now.Add(reminderMinAhead)) {
			return nil, fmt.Errorf("the reminder time %s has already passed", reminderLocal(due, location))
		}
		if due.After(now.Add(reminderMaxAhead)) {
			return nil, fmt.Errorf("reminders can be at most a year ahead")
		}
		var open int
		if err := a.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM reminders WHERE user_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL`, userID).Scan(&open); err != nil {
			return nil, err
		}
		if open >= reminderMaxOpen {
			return nil, fmt.Errorf("there are already %d upcoming reminders; cancel one first", open)
		}
		conversation := uuid.NullUUID{UUID: conversationID, Valid: conversationID != uuid.Nil}
		var id uuid.UUID
		err = a.DB.QueryRowContext(ctx, `INSERT INTO reminders (user_id, organization_id, conversation_id, message, due_at)
			VALUES ($1, $2, (SELECT id FROM conversations WHERE id = $3), $4, $5) RETURNING id`,
			userID, organizationID, conversation, message, due).Scan(&id)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"reminderId": id, "message": message, "dueAt": due.UTC().Format(time.RFC3339), "dueLocal": reminderLocal(due, location), "timeZone": location.String()})
	case "list_reminders":
		rows, err := a.DB.QueryContext(ctx, `SELECT id, message, due_at FROM reminders WHERE user_id = $1 AND organization_id = $2 AND sent_at IS NULL AND cancelled_at IS NULL ORDER BY due_at LIMIT $3`, userID, organizationID, reminderMaxOpen)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		items := []map[string]any{}
		for rows.Next() {
			var id uuid.UUID
			var message string
			var due time.Time
			if err := rows.Scan(&id, &message, &due); err != nil {
				return nil, err
			}
			items = append(items, map[string]any{"reminderId": id, "message": message, "dueLocal": reminderLocal(due, location)})
		}
		return json.Marshal(map[string]any{"reminders": items, "timeZone": location.String()})
	case "cancel_reminder":
		id, err := uuid.Parse(stringToolArgument(args, "reminderId"))
		if err != nil {
			return nil, fmt.Errorf("a valid reminderId is required")
		}
		var message string
		err = a.DB.QueryRowContext(ctx, `UPDATE reminders SET cancelled_at = now() WHERE id = $1 AND user_id = $2 AND sent_at IS NULL AND cancelled_at IS NULL RETURNING message`, id, userID).Scan(&message)
		if err != nil {
			return nil, errors.New("no upcoming reminder with this id")
		}
		return json.Marshal(map[string]any{"cancelled": true, "reminderId": id, "message": message})
	}
	return nil, fmt.Errorf("unknown reminder tool %s", name)
}

// claimDueReminders marks due reminders as sent and returns them as notifications.
func (a *App) claimDueReminders(ctx context.Context) []notificationEvent {
	rows, err := a.DB.QueryContext(ctx, `UPDATE reminders SET sent_at = now()
		WHERE due_at <= now() AND sent_at IS NULL AND cancelled_at IS NULL
		RETURNING id, user_id, organization_id, conversation_id, message`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var events []notificationEvent
	for rows.Next() {
		var id uuid.UUID
		var conversation uuid.NullUUID
		event := notificationEvent{Kind: "reminder", Link: "/"}
		if rows.Scan(&id, &event.UserID, &event.OrganizationID, &conversation, &event.Message) != nil {
			continue
		}
		if conversation.Valid {
			event.Link = "/" + conversation.UUID.String()
		}
		event.DedupeKey = "reminder:" + id.String()
		events = append(events, event)
	}
	return events
}
