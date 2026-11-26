package server

import (
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"

	"justai-backend/config"
)

// mailMessage is one notification e-mail, as plain text with an HTML alternative.
type mailMessage struct {
	To        string
	Subject   string
	Text      string
	LinkLabel string
	Link      string
}

// buildMail renders the MIME message. Header values cannot carry line breaks.
func buildMail(from string, msg mailMessage, now time.Time) ([]byte, error) {
	clean := func(value string) string { return strings.NewReplacer("\r", " ", "\n", " ").Replace(value) }
	sender, err := mail.ParseAddress(from)
	if err != nil {
		return nil, fmt.Errorf("invalid sender: %w", err)
	}
	recipient, err := mail.ParseAddress(clean(msg.To))
	if err != nil {
		return nil, fmt.Errorf("invalid recipient: %w", err)
	}
	random := make([]byte, 12)
	_, _ = rand.Read(random)
	boundary := "justai-" + hex.EncodeToString(random)
	domain := sender.Address[strings.LastIndex(sender.Address, "@")+1:]

	text := msg.Text
	if msg.Link != "" {
		text += "\n\n" + msg.LinkLabel + ": " + msg.Link
	}
	htmlBody := "<p>" + strings.ReplaceAll(html.EscapeString(msg.Text), "\n", "<br>") + "</p>"
	if msg.Link != "" {
		htmlBody += `<p><a href="` + html.EscapeString(msg.Link) + `">` + html.EscapeString(msg.LinkLabel) + `</a></p>`
	}

	var b bytes.Buffer
	header := func(name, value string) { fmt.Fprintf(&b, "%s: %s\r\n", name, value) }
	header("From", sender.String())
	header("To", recipient.String())
	header("Subject", mime.QEncoding.Encode("utf-8", clean(msg.Subject)))
	header("Date", now.Format(time.RFC1123Z))
	header("Message-ID", "<"+hex.EncodeToString(random)+"@"+domain+">")
	header("MIME-Version", "1.0")
	header("Auto-Submitted", "auto-generated")
	header("Content-Type", `multipart/alternative; boundary="`+boundary+`"`)
	b.WriteString("\r\n")
	for _, part := range []struct{ kind, body string }{{"text/plain", text}, {"text/html", htmlBody}} {
		fmt.Fprintf(&b, "--%s\r\nContent-Type: %s; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n", boundary, part.kind)
		writer := quotedprintable.NewWriter(&b)
		_, _ = writer.Write([]byte(part.body))
		_ = writer.Close()
		b.WriteString("\r\n")
	}
	fmt.Fprintf(&b, "--%s--\r\n", boundary)
	return b.Bytes(), nil
}

// sendMail delivers one message through the configured SMTP server.
func sendMail(cfg config.SMTPConfig, msg mailMessage) error {
	if cfg.Host == "" {
		return errors.New("smtp is not configured")
	}
	body, err := buildMail(cfg.From, msg, time.Now())
	if err != nil {
		return err
	}
	address := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	dialer := &net.Dialer{Timeout: 15 * time.Second}
	var conn net.Conn
	if cfg.Security == "tls" {
		conn, err = tls.DialWithDialer(dialer, "tcp", address, &tls.Config{ServerName: cfg.Host, MinVersion: tls.VersionTLS12})
	} else {
		conn, err = dialer.Dial("tcp", address)
	}
	if err != nil {
		return err
	}
	_ = conn.SetDeadline(time.Now().Add(time.Minute))
	client, err := smtp.NewClient(conn, cfg.Host)
	if err != nil {
		conn.Close()
		return err
	}
	defer client.Close()
	if cfg.Security == "starttls" {
		if err := client.StartTLS(&tls.Config{ServerName: cfg.Host, MinVersion: tls.VersionTLS12}); err != nil {
			return fmt.Errorf("starttls: %w", err)
		}
	}
	if cfg.Username != "" {
		if err := client.Auth(smtp.PlainAuth("", cfg.Username, cfg.Password, cfg.Host)); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}
	sender, _ := mail.ParseAddress(cfg.From)
	recipient, _ := mail.ParseAddress(msg.To)
	if err := client.Mail(sender.Address); err != nil {
		return err
	}
	if err := client.Rcpt(recipient.Address); err != nil {
		return err
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}
	if _, err := writer.Write(body); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	return client.Quit()
}
