package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"justai-backend/config"
)

type s3Storage struct {
	endpoint           *url.URL
	processingEndpoint *url.URL
	region             string
	bucket             string
	access             string
	secret             string
	client             *http.Client
}

type s3ResponseError struct {
	status  int
	message string
}

func (e *s3ResponseError) Error() string {
	return fmt.Sprintf("s3 request failed with status %d: %s", e.status, e.message)
}

func newS3Storage(cfg config.Config) (*s3Storage, error) {
	if cfg.Transcription.S3Bucket == "" || cfg.Transcription.S3AccessKey == "" || cfg.Transcription.S3SecretKey == "" {
		return nil, fmt.Errorf("s3 recording requires s3_bucket, s3_access_key, and s3_secret_key")
	}
	endpointValue := cfg.Transcription.S3Endpoint
	if endpointValue == "" {
		endpointValue = "https://s3." + cfg.Transcription.S3Region + ".amazonaws.com"
	}
	endpoint, err := parseS3Endpoint(endpointValue)
	if err != nil {
		return nil, fmt.Errorf("invalid s3 endpoint")
	}
	processingEndpoint := endpoint
	if value := strings.TrimSpace(cfg.Transcription.S3ProcessingEndpoint); value != "" {
		processingEndpoint, err = parseS3Endpoint(value)
		if err != nil {
			return nil, fmt.Errorf("invalid s3 processing endpoint")
		}
	}
	region := cfg.Transcription.S3Region
	if region == "" {
		region = "us-east-1"
	}
	clientTimeout := 30 * time.Minute
	if cfg.Transcription.VideoMaxDurationHours > 0 {
		videoTimeout := time.Duration(cfg.Transcription.VideoMaxDurationHours+2) * time.Hour
		if videoTimeout > clientTimeout {
			clientTimeout = videoTimeout
		}
	}
	return &s3Storage{
		endpoint:           endpoint,
		processingEndpoint: processingEndpoint,
		region:             region,
		bucket:             cfg.Transcription.S3Bucket,
		access:             cfg.Transcription.S3AccessKey,
		secret:             cfg.Transcription.S3SecretKey,
		client:             &http.Client{Timeout: clientTimeout},
	}, nil
}

func parseS3Endpoint(value string) (*url.URL, error) {
	endpoint, err := url.Parse(strings.TrimSpace(value))
	if err != nil || endpoint.Host == "" || (endpoint.Scheme != "http" && endpoint.Scheme != "https") {
		return nil, fmt.Errorf("invalid endpoint")
	}
	return endpoint, nil
}

func (s *s3Storage) objectURL(key string) *url.URL {
	return s.objectURLAt(s.endpoint, key)
}

func (s *s3Storage) objectURLAt(endpoint *url.URL, key string) *url.URL {
	result := *endpoint
	result.RawQuery = ""
	result.RawPath = ""
	result.Path = strings.TrimRight(endpoint.Path, "/") + "/" + s.bucket + "/" + strings.TrimLeft(key, "/")
	return &result
}

func (s *s3Storage) request(ctx context.Context, method, key string, query url.Values, body []byte, contentType string) (*http.Response, error) {
	object := s.objectURL(key)
	object.RawQuery = canonicalQuery(query)
	payloadHash := hashBytes(body)
	request, err := http.NewRequestWithContext(ctx, method, object.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Host", object.Host)
	request.Header.Set("x-amz-content-sha256", payloadHash)
	amzTime := time.Now().UTC()
	request.Header.Set("x-amz-date", amzTime.Format("20060102T150405Z"))
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	canonicalHeaders, signedHeaders := canonicalHeaders(request.Header, object.Host)
	canonicalRequest := strings.Join([]string{method, object.EscapedPath(), canonicalQuery(query), canonicalHeaders, signedHeaders, payloadHash}, "\n")
	date := amzTime.Format("20060102")
	scope := date + "/" + s.region + "/s3/aws4_request"
	stringToSign := strings.Join([]string{"AWS4-HMAC-SHA256", amzTime.Format("20060102T150405Z"), scope, hashBytes([]byte(canonicalRequest))}, "\n")
	signingKey := hmacSHA256(hmacSHA256(hmacSHA256(hmacSHA256([]byte("AWS4"+s.secret), date), s.region), "s3"), "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(signingKey, stringToSign))
	request.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+s.access+"/"+scope+", SignedHeaders="+signedHeaders+", Signature="+signature)
	request.Host = object.Host
	return s.client.Do(request)
}

func (s *s3Storage) presignURL(method, key string, query url.Values, lifetime time.Duration) string {
	return s.presignURLAt(s.endpoint, method, key, query, lifetime)
}

func (s *s3Storage) presignProcessingURL(method, key string, query url.Values, lifetime time.Duration) string {
	return s.presignURLAt(s.processingEndpoint, method, key, query, lifetime)
}

func (s *s3Storage) presignURLAt(endpoint *url.URL, method, key string, query url.Values, lifetime time.Duration) string {
	return s.presignURLAtWithHeaders(endpoint, method, key, query, lifetime, nil)
}

func (s *s3Storage) presignURLAtWithHeaders(endpoint *url.URL, method, key string, query url.Values, lifetime time.Duration, signedHeaderValues map[string]string) string {
	object := s.objectURLAt(endpoint, key)
	if lifetime <= 0 {
		lifetime = 15 * time.Minute
	}
	if lifetime > 7*24*time.Hour {
		lifetime = 7 * 24 * time.Hour
	}
	now := time.Now().UTC()
	date := now.Format("20060102")
	scope := date + "/" + s.region + "/s3/aws4_request"
	values := cloneURLValues(query)
	values.Set("X-Amz-Algorithm", "AWS4-HMAC-SHA256")
	values.Set("X-Amz-Credential", s.access+"/"+scope)
	values.Set("X-Amz-Date", now.Format("20060102T150405Z"))
	values.Set("X-Amz-Expires", strconv.FormatInt(int64(lifetime/time.Second), 10))
	signedHeaderNames := []string{"host"}
	for name := range signedHeaderValues {
		signedHeaderNames = append(signedHeaderNames, strings.ToLower(strings.TrimSpace(name)))
	}
	sort.Strings(signedHeaderNames)
	values.Set("X-Amz-SignedHeaders", strings.Join(signedHeaderNames, ";"))
	canonicalHeaderValues := make(map[string]string, len(signedHeaderValues)+1)
	canonicalHeaderValues["host"] = object.Host
	for name, value := range signedHeaderValues {
		canonicalHeaderValues[strings.ToLower(strings.TrimSpace(name))] = strings.TrimSpace(value)
	}
	var canonicalHeadersBuilder strings.Builder
	for _, name := range signedHeaderNames {
		canonicalHeadersBuilder.WriteString(name)
		canonicalHeadersBuilder.WriteByte(':')
		canonicalHeadersBuilder.WriteString(canonicalHeaderValues[name])
		canonicalHeadersBuilder.WriteByte('\n')
	}
	canonicalHeaders := canonicalHeadersBuilder.String()
	canonicalQueryValue := canonicalQuery(values)
	canonicalRequest := strings.Join([]string{
		method,
		object.EscapedPath(),
		canonicalQueryValue,
		canonicalHeaders,
		strings.Join(signedHeaderNames, ";"),
		"UNSIGNED-PAYLOAD",
	}, "\n")
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		now.Format("20060102T150405Z"),
		scope,
		hashBytes([]byte(canonicalRequest)),
	}, "\n")
	signingKey := hmacSHA256(hmacSHA256(hmacSHA256(hmacSHA256([]byte("AWS4"+s.secret), date), s.region), "s3"), "aws4_request")
	values.Set("X-Amz-Signature", hex.EncodeToString(hmacSHA256(signingKey, stringToSign)))
	object.RawQuery = canonicalQuery(values)
	return object.String()
}

func cloneURLValues(values url.Values) url.Values {
	result := make(url.Values, len(values))
	for key, items := range values {
		result[key] = append([]string(nil), items...)
	}
	return result
}

type s3MultipartInitiation struct {
	UploadID string `xml:"UploadId"`
}

type s3MultipartPart struct {
	PartNumber int    `xml:"PartNumber"`
	ETag       string `xml:"ETag"`
}

type s3MultipartCompletion struct {
	XMLName xml.Name          `xml:"CompleteMultipartUpload"`
	Parts   []s3MultipartPart `xml:"Part"`
}

func (s *s3Storage) initiateMultipart(ctx context.Context, key, contentType string) (string, error) {
	query := url.Values{}
	query.Set("uploads", "")
	response, err := s.request(ctx, http.MethodPost, key, query, nil, contentType)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusMultipleChoices {
		return "", s3ErrorFromResponse(response)
	}
	var result s3MultipartInitiation
	if err := xml.NewDecoder(response.Body).Decode(&result); err != nil {
		return "", err
	}
	if strings.TrimSpace(result.UploadID) == "" {
		return "", fmt.Errorf("s3 multipart initiation returned no upload id")
	}
	return result.UploadID, nil
}

func (s *s3Storage) presignMultipartPart(key, uploadID string, partNumber int, lifetime time.Duration, expectedLength ...int64) string {
	query := url.Values{}
	query.Set("partNumber", strconv.Itoa(partNumber))
	query.Set("uploadId", uploadID)
	if len(expectedLength) > 0 && expectedLength[0] > 0 {
		return s.presignURLAtWithHeaders(s.endpoint, http.MethodPut, key, query, lifetime, map[string]string{"content-length": strconv.FormatInt(expectedLength[0], 10)})
	}
	return s.presignURL(http.MethodPut, key, query, lifetime)
}

func (s *s3Storage) completeMultipart(ctx context.Context, key, uploadID string, parts []s3MultipartPart) error {
	payload, err := xml.Marshal(s3MultipartCompletion{Parts: parts})
	if err != nil {
		return err
	}
	query := url.Values{}
	query.Set("uploadId", uploadID)
	response, err := s.request(ctx, http.MethodPost, key, query, payload, "application/xml")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if err := readS3Response(response); err != nil {
		return err
	}
	return nil
}

// objectSize reads the authoritative object length after multipart
// completion. The client-provided expected size is only metadata; S3 HEAD is
// the source of truth before a completed upload can enter the processing
// queue.
func (s *s3Storage) objectSize(ctx context.Context, key string) (int64, error) {
	response, err := s.request(ctx, http.MethodHead, key, nil, nil, "")
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusMultipleChoices {
		return 0, s3ErrorFromResponse(response)
	}
	if response.ContentLength < 0 {
		return 0, fmt.Errorf("s3 HEAD response omitted object size")
	}
	return response.ContentLength, nil
}

func (s *s3Storage) completeMultipartAndVerify(ctx context.Context, key, uploadID string, parts []s3MultipartPart, expectedBytes int64) error {
	if err := s.completeMultipart(ctx, key, uploadID, parts); err != nil {
		return err
	}
	actualBytes, err := s.objectSize(ctx, key)
	if err != nil {
		_ = s.delete(ctx, key)
		return fmt.Errorf("could not verify completed upload size: %w", err)
	}
	if actualBytes != expectedBytes {
		_ = s.delete(ctx, key)
		_ = s.abortMultipart(ctx, key, uploadID)
		return fmt.Errorf("uploaded object size %d bytes does not match declared size %d bytes", actualBytes, expectedBytes)
	}
	return nil
}

func (s *s3Storage) abortMultipart(ctx context.Context, key, uploadID string) error {
	query := url.Values{}
	query.Set("uploadId", uploadID)
	response, err := s.request(ctx, http.MethodDelete, key, query, nil, "")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	return readS3Response(response)
}

func (s *s3Storage) put(ctx context.Context, key string, body []byte, contentType string) error {
	response, err := s.request(ctx, http.MethodPut, key, nil, body, contentType)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	return readS3Response(response)
}

func (s *s3Storage) get(ctx context.Context, key string) (io.ReadCloser, error) {
	response, err := s.request(ctx, http.MethodGet, key, nil, nil, "")
	if err != nil {
		return nil, err
	}
	if response.StatusCode >= http.StatusMultipleChoices {
		defer response.Body.Close()
		return nil, s3ErrorFromResponse(response)
	}
	return response.Body, nil
}

func (s *s3Storage) delete(ctx context.Context, key string) error {
	response, err := s.request(ctx, http.MethodDelete, key, nil, nil, "")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil
	}
	return readS3Response(response)
}

func (s *s3Storage) list(ctx context.Context, prefix string) ([]string, error) {
	return s.listWithoutRead(ctx, prefix)
}

func (s *s3Storage) listWithoutRead(ctx context.Context, prefix string) ([]string, error) {
	query := url.Values{"list-type": {"2"}, "prefix": {prefix}}
	response, err := s.request(ctx, http.MethodGet, "", query, nil, "")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusMultipleChoices {
		return nil, s3ErrorFromResponse(response)
	}
	var result struct {
		Contents []struct {
			Key string `xml:"Key"`
		} `xml:"Contents"`
	}
	if err := xml.NewDecoder(response.Body).Decode(&result); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(result.Contents))
	for _, item := range result.Contents {
		keys = append(keys, item.Key)
	}
	return keys, nil
}

func (s *s3Storage) deletePrefix(ctx context.Context, prefix string) error {
	keys, err := s.listWithoutRead(ctx, prefix)
	if err != nil {
		return err
	}
	for _, key := range keys {
		if err := s.delete(ctx, key); err != nil {
			return err
		}
	}
	return nil
}

func readS3Response(response *http.Response) error {
	if response.StatusCode < http.StatusMultipleChoices {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil
	}
	return s3ErrorFromResponse(response)
}

func s3ErrorFromResponse(response *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	message := strings.TrimSpace(string(body))
	if message == "" {
		message = response.Status
	}
	return &s3ResponseError{status: response.StatusCode, message: message}
}

func canonicalHeaders(headers http.Header, host string) (string, string) {
	values := map[string]string{"host": strings.TrimSpace(host)}
	for name, value := range headers {
		lower := strings.ToLower(name)
		if lower == "host" || lower == "authorization" {
			continue
		}
		if len(value) > 0 {
			values[lower] = strings.Join(value, ",")
		}
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var canonical strings.Builder
	for _, key := range keys {
		canonical.WriteString(key)
		canonical.WriteByte(':')
		canonical.WriteString(strings.Join(strings.Fields(values[key]), " "))
		canonical.WriteByte('\n')
	}
	return canonical.String(), strings.Join(keys, ";")
}

func canonicalQuery(query url.Values) string {
	if len(query) == 0 {
		return ""
	}
	type pair struct{ key, value string }
	pairs := make([]pair, 0)
	for key, values := range query {
		for _, value := range values {
			pairs = append(pairs, pair{awsEscape(key), awsEscape(value)})
		}
	}
	sort.Slice(pairs, func(left, right int) bool {
		if pairs[left].key == pairs[right].key {
			return pairs[left].value < pairs[right].value
		}
		return pairs[left].key < pairs[right].key
	})
	result := make([]string, 0, len(pairs))
	for _, item := range pairs {
		result = append(result, item.key+"="+item.value)
	}
	return strings.Join(result, "&")
}

func awsEscape(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(url.QueryEscape(value), "+", "%20"), "%7E", "~")
}

func hashBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key []byte, value string) []byte {
	hasher := hmac.New(sha256.New, key)
	_, _ = hasher.Write([]byte(value))
	return hasher.Sum(nil)
}
