package server

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"justai-backend/provider"
)

// Web Push without a third-party library: payload encryption per RFC 8291
// (aes128gcm, RFC 8188) and VAPID authentication per RFC 8292.

var b64 = base64.RawURLEncoding

// decodeB64 accepts the URL-safe alphabet with or without padding, as browsers send it.
func decodeB64(value string) ([]byte, error) {
	value = strings.TrimRight(strings.TrimSpace(value), "=")
	value = strings.NewReplacer("+", "-", "/", "_").Replace(value)
	return b64.DecodeString(value)
}

// encryptPushPayload encrypts plaintext for one subscription. asPrivate and salt are
// fresh per message; they are parameters so tests can use the RFC 8291 vectors.
func encryptPushPayload(uaPublic, authSecret, plaintext []byte, asPrivate *ecdh.PrivateKey, salt []byte) ([]byte, error) {
	if len(authSecret) != 16 || len(salt) != 16 {
		return nil, errors.New("push: auth secret and salt must be 16 bytes")
	}
	uaKey, err := ecdh.P256().NewPublicKey(uaPublic)
	if err != nil {
		return nil, fmt.Errorf("push: invalid subscription key: %w", err)
	}
	shared, err := asPrivate.ECDH(uaKey)
	if err != nil {
		return nil, err
	}
	asPublic := asPrivate.PublicKey().Bytes()
	keyInfo := append(append([]byte("WebPush: info\x00"), uaPublic...), asPublic...)
	ikm, err := hkdf.Key(sha256.New, shared, authSecret, string(keyInfo), 32)
	if err != nil {
		return nil, err
	}
	prk, err := hkdf.Extract(sha256.New, ikm, salt)
	if err != nil {
		return nil, err
	}
	cek, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	if err != nil {
		return nil, err
	}
	nonce, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	const recordSize = 4096
	if len(plaintext)+1+gcm.Overhead() > recordSize {
		return nil, errors.New("push: payload too large")
	}
	// One record: the plaintext, then the last-record delimiter 0x02.
	sealed := gcm.Seal(nil, nonce, append(append([]byte{}, plaintext...), 0x02), nil)
	var body bytes.Buffer
	body.Write(salt)
	_ = binary.Write(&body, binary.BigEndian, uint32(recordSize))
	body.WriteByte(byte(len(asPublic)))
	body.Write(asPublic)
	body.Write(sealed)
	return body.Bytes(), nil
}

// vapidKeys is the instance's application server key pair.
type vapidKeys struct {
	private   *ecdsa.PrivateKey
	publicB64 string // uncompressed point, as PushManager.subscribe wants it
}

var (
	vapidMu     sync.Mutex
	vapidCached *vapidKeys
)

// loadVAPIDKeys returns the key pair, making and storing one on first use.
func (a *App) loadVAPIDKeys(ctx context.Context) (*vapidKeys, error) {
	vapidMu.Lock()
	defer vapidMu.Unlock()
	if vapidCached != nil {
		return vapidCached, nil
	}
	var public string
	var ciphertext []byte
	err := a.DB.QueryRowContext(ctx, `SELECT public_key, private_key_ciphertext FROM push_vapid_keys WHERE id = 1`).Scan(&public, &ciphertext)
	if errors.Is(err, sql.ErrNoRows) {
		key, genErr := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if genErr != nil {
			return nil, genErr
		}
		der, genErr := x509.MarshalECPrivateKey(key)
		if genErr != nil {
			return nil, genErr
		}
		encrypted, genErr := a.Secrets.Encrypt(b64.EncodeToString(der))
		if genErr != nil {
			return nil, genErr
		}
		ecdhKey, genErr := key.PublicKey.ECDH()
		if genErr != nil {
			return nil, genErr
		}
		// Another replica may have stored its pair first; then use that one.
		if _, genErr = a.DB.ExecContext(ctx, `INSERT INTO push_vapid_keys (id, public_key, private_key_ciphertext) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING`, b64.EncodeToString(ecdhKey.Bytes()), encrypted); genErr != nil {
			return nil, genErr
		}
		err = a.DB.QueryRowContext(ctx, `SELECT public_key, private_key_ciphertext FROM push_vapid_keys WHERE id = 1`).Scan(&public, &ciphertext)
	}
	if err != nil {
		return nil, err
	}
	encoded, err := a.Secrets.Decrypt(ciphertext)
	if err != nil {
		return nil, fmt.Errorf("push: cannot decrypt the VAPID key (was the encryption key changed?): %w", err)
	}
	der, err := b64.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	key, err := x509.ParseECPrivateKey(der)
	if err != nil {
		return nil, err
	}
	vapidCached = &vapidKeys{private: key, publicB64: public}
	return vapidCached, nil
}

// vapidAuthorization signs the RFC 8292 header for the push service of endpoint.
func vapidAuthorization(keys *vapidKeys, endpoint, subject string, now time.Time) (string, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return "", errors.New("push: the endpoint must be an https URL")
	}
	token := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{
		"aud": parsed.Scheme + "://" + parsed.Host,
		"exp": now.Add(12 * time.Hour).Unix(),
		"sub": subject,
	})
	signed, err := token.SignedString(keys.private)
	if err != nil {
		return "", err
	}
	return "vapid t=" + signed + ", k=" + keys.publicB64, nil
}

// errPushGone: the browser dropped the subscription; it should be deleted.
var errPushGone = errors.New("push subscription is gone")

type pushSubscription struct {
	Endpoint string
	P256dh   string
	Auth     string
}

// pushClient never connects to private addresses, whatever a subscription claims.
var pushClient = provider.SafeHTTPClient(15*time.Second, false)

func sendWebPush(ctx context.Context, keys *vapidKeys, subject string, sub pushSubscription, payload []byte) error {
	uaPublic, err := decodeB64(sub.P256dh)
	if err != nil {
		return fmt.Errorf("push: invalid p256dh: %w", err)
	}
	auth, err := decodeB64(sub.Auth)
	if err != nil {
		return fmt.Errorf("push: invalid auth: %w", err)
	}
	ephemeral, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	salt := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return err
	}
	body, err := encryptPushPayload(uaPublic, auth, payload, ephemeral, salt)
	if err != nil {
		return err
	}
	authorization, err := vapidAuthorization(keys, sub.Endpoint, subject, time.Now())
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, sub.Endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Header.Set("Content-Encoding", "aes128gcm")
	request.Header.Set("TTL", "86400")
	request.Header.Set("Urgency", "normal")
	request.Header.Set("Authorization", authorization)
	response, err := pushClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	switch {
	case response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusGone:
		return errPushGone
	case response.StatusCode >= 300:
		return fmt.Errorf("push service answered %d", response.StatusCode)
	}
	return nil
}

// validPushEndpoint keeps subscriptions to public https push services; the backend
// posts to this URL, so it must not point at internal hosts.
func validPushEndpoint(endpoint string) bool {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || len(endpoint) > 2048 {
		return false
	}
	return provider.ValidateRequestURL(endpoint, false) == nil
}
