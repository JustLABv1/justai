package server

import (
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// RFC 8291, Appendix A.
func TestEncryptPushPayloadMatchesRFC8291(t *testing.T) {
	mustB64 := func(value string) []byte {
		decoded, err := decodeB64(value)
		if err != nil {
			t.Fatal(err)
		}
		return decoded
	}
	asPrivate, err := ecdh.P256().NewPrivateKey(mustB64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"))
	if err != nil {
		t.Fatal(err)
	}
	if got := b64.EncodeToString(asPrivate.PublicKey().Bytes()); got != "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8" {
		t.Fatalf("as_public = %s", got)
	}
	body, err := encryptPushPayload(
		mustB64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
		mustB64("BTBZMqHH6r4Tts7J_aSIgg"),
		[]byte("When I grow up, I want to be a watermelon"),
		asPrivate,
		mustB64("DGv6ra1nlYgDCS1FRnbzlw"),
	)
	if err != nil {
		t.Fatal(err)
	}
	want := "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
	if got := b64.EncodeToString(body); got != want {
		t.Fatalf("body =\n%s\nwant\n%s", got, want)
	}
}

func TestVAPIDAuthorizationIsSignedForThePushService(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	public, _ := key.PublicKey.ECDH()
	keys := &vapidKeys{private: key, publicB64: b64.EncodeToString(public.Bytes())}
	header, err := vapidAuthorization(keys, "https://fcm.googleapis.com/fcm/send/abc", "mailto:ops@example.org", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	token, k, ok := strings.Cut(strings.TrimPrefix(header, "vapid t="), ", k=")
	if !ok || k != keys.publicB64 {
		t.Fatalf("header = %s", header)
	}
	parsed, err := jwt.Parse(token, func(*jwt.Token) (any, error) { return &key.PublicKey, nil }, jwt.WithValidMethods([]string{"ES256"}), jwt.WithAudience("https://fcm.googleapis.com"))
	if err != nil || !parsed.Valid {
		t.Fatalf("token invalid: %v", err)
	}
	if _, err := vapidAuthorization(keys, "http://insecure.example/x", "mailto:a@b.c", time.Now()); err == nil {
		t.Fatal("an http endpoint was accepted")
	}
}

func TestPushEndpointMustBePublicHTTPS(t *testing.T) {
	for endpoint, want := range map[string]bool{
		"https://fcm.googleapis.com/fcm/send/abc":            true,
		"https://updates.push.services.mozilla.com/wpush/v2": true,
		"http://fcm.googleapis.com/x":                        false,
		"https://127.0.0.1/x":                                false,
		"https://10.0.0.5/x":                                 false,
		"https://localhost/x":                                false,
		"https://user:pw@fcm.googleapis.com/x":               false,
	} {
		if got := validPushEndpoint(endpoint); got != want {
			t.Errorf("%s: got %v, want %v", endpoint, got, want)
		}
	}
}
