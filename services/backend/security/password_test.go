package security

import "testing"

func TestPasswordRoundTrip(t *testing.T) {
	hashed, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if !CheckPassword("correct horse battery staple", hashed) {
		t.Fatal("expected password to verify")
	}
	if CheckPassword("wrong password", hashed) {
		t.Fatal("expected wrong password to fail")
	}
}
