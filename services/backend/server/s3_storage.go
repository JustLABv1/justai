package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
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

func s3ErrorHasStatus(err error, status int) bool {
	var responseErr *s3ResponseError
	return errors.As(err, &responseErr) && responseErr.status == status
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
	return s.requestReaderAt(ctx, s.endpoint, method, key, query, nil, bytes.NewReader(body), int64(len(body)), contentType, hashBytes(body))
}

// requestReader signs and sends a request without materializing its body in
// memory. UNSIGNED-PAYLOAD is supported by S3-compatible services and avoids
// buffering a multi-megabyte upload just to calculate the SigV4 payload hash.
func (s *s3Storage) requestReader(ctx context.Context, method, key string, query url.Values, body io.Reader, contentLength int64, contentType, payloadHash string) (*http.Response, error) {
	return s.requestReaderAt(ctx, s.endpoint, method, key, query, nil, body, contentLength, contentType, payloadHash)
}

func (s *s3Storage) requestReaderAt(ctx context.Context, endpoint *url.URL, method, key string, query url.Values, headers http.Header, body io.Reader, contentLength int64, contentType, payloadHash string) (*http.Response, error) {
	object := s.objectURLAt(endpoint, key)
	object.RawQuery = canonicalQuery(query)
	request, err := http.NewRequestWithContext(ctx, method, object.String(), body)
	if err != nil {
		return nil, err
	}
	if headers == nil {
		request.Header = make(http.Header)
	} else {
		request.Header = headers.Clone()
	}
	request.Header.Set("Host", object.Host)
	request.Header.Set("x-amz-content-sha256", payloadHash)
	if contentLength >= 0 {
		request.ContentLength = contentLength
		request.Header.Set("Content-Length", strconv.FormatInt(contentLength, 10))
	}
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

type s3MultipartUploadResult struct {
	PartNumber int
	ETag       string
	SizeBytes  int64
}

// uploadMultipartPart forwards exactly one video part to S3. The caller must
// validate the part size before calling this method; Content-Length is signed
// so the upstream cannot silently receive a different part size.
func (s *s3Storage) uploadMultipartPart(ctx context.Context, key, uploadID string, partNumber int, body io.Reader, contentLength int64, contentType string) (s3MultipartUploadResult, error) {
	query := url.Values{}
	query.Set("partNumber", strconv.Itoa(partNumber))
	query.Set("uploadId", uploadID)
	response, err := s.requestReader(ctx, http.MethodPut, key, query, body, contentLength, contentType, "UNSIGNED-PAYLOAD")
	if err != nil {
		return s3MultipartUploadResult{}, err
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusMultipleChoices {
		return s3MultipartUploadResult{}, s3ErrorFromResponse(response)
	}
	if err := readS3Response(response); err != nil {
		return s3MultipartUploadResult{}, err
	}
	etag := strings.TrimSpace(response.Header.Get("ETag"))
	if etag == "" || len(etag) > 256 || strings.ContainsAny(etag, "\r\n") {
		return s3MultipartUploadResult{}, fmt.Errorf("s3 multipart upload returned no valid ETag")
	}
	return s3MultipartUploadResult{PartNumber: partNumber, ETag: etag, SizeBytes: contentLength}, nil
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
	if response.StatusCode >= http.StatusMultipleChoices {
		return s3ErrorFromResponse(response)
	}
	return readS3CompletionResponse(response)
}

func readS3CompletionResponse(response *http.Response) error {
	body, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(body)) == 0 {
		// Empty successful responses are used by several S3-compatible gateways.
		return nil
	}
	var result struct {
		XMLName xml.Name
		Code    string `xml:"Code"`
		Message string `xml:"Message"`
	}
	if err := xml.Unmarshal(body, &result); err != nil {
		return fmt.Errorf("S3 completion returned invalid XML: %w", err)
	}
	if result.XMLName.Local == "Error" || strings.TrimSpace(result.Code) != "" {
		message := strings.TrimSpace(result.Message)
		if message == "" {
			message = strings.TrimSpace(result.Code)
		}
		if message == "" {
			message = "multipart completion returned an embedded error"
		}
		return &s3ResponseError{status: http.StatusBadGateway, message: message}
	}
	return nil
}

type s3ObjectVerificationError struct {
	attempts         []string
	cause            error
	permissionDenied bool
	notFound         bool
}

func (e *s3ObjectVerificationError) Error() string {
	detail := strings.Join(e.attempts, "; ")
	message := "could not verify S3 object size"
	switch {
	case e.permissionDenied:
		message += ": object-read access was denied by the configured S3 endpoint(s); grant the backend credentials s3:GetObject/read permission or configure a readable s3_processing_endpoint"
	case e.notFound:
		message += ": the completed object was not found; check the bucket, object key, and S3 gateway routing"
	default:
		message += ": all configured S3 object-size probes failed; retry after the gateway recovers or configure a readable s3_processing_endpoint"
	}
	if detail != "" {
		message += " (" + detail + ")"
	}
	return message
}

func (e *s3ObjectVerificationError) Unwrap() error {
	return e.cause
}

// objectSize verifies an already-created object without downloading it. Some
// S3-compatible gateways reject HEAD even when GET is allowed, so every
// endpoint is tried with HEAD first and a one-byte ranged GET second.
func (s *s3Storage) objectSize(ctx context.Context, key string) (int64, error) {
	endpoints := []*url.URL{s.endpoint}
	if s.processingEndpoint != nil && !sameS3Endpoint(s.endpoint, s.processingEndpoint) {
		endpoints = append(endpoints, s.processingEndpoint)
	}
	attempts := make([]string, 0, len(endpoints)*2)
	errorsSeen := make([]error, 0, len(endpoints)*2)
	verification := &s3ObjectVerificationError{}
	for _, endpoint := range endpoints {
		size, err := s.objectSizeHead(ctx, endpoint, key)
		if err == nil {
			return size, nil
		}
		attempts = append(attempts, fmt.Sprintf("HEAD %s: %v", endpoint.Host, err))
		errorsSeen = append(errorsSeen, err)
		verification.record(err, http.MethodHead)

		size, err = s.objectSizeRangeGet(ctx, endpoint, key)
		if err == nil {
			return size, nil
		}
		attempts = append(attempts, fmt.Sprintf("GET range %s: %v", endpoint.Host, err))
		errorsSeen = append(errorsSeen, err)
		verification.record(err, http.MethodGet)
	}
	verification.attempts = attempts
	verification.cause = errors.Join(errorsSeen...)
	return 0, verification
}

func (e *s3ObjectVerificationError) record(err error, method string) {
	var responseErr *s3ResponseError
	if !errors.As(err, &responseErr) {
		return
	}
	switch responseErr.status {
	case http.StatusUnauthorized, http.StatusForbidden:
		// A gateway-specific HEAD policy is the reason for this fallback. Only
		// a denied GET proves that the credentials cannot read the object.
		if method == http.MethodGet {
			e.permissionDenied = true
		}
	case http.StatusNotFound:
		e.notFound = true
	}
}

func sameS3Endpoint(left, right *url.URL) bool {
	if left == nil || right == nil {
		return left == right
	}
	return left.Scheme == right.Scheme && left.Host == right.Host && strings.TrimRight(left.Path, "/") == strings.TrimRight(right.Path, "/")
}

func (s *s3Storage) objectSizeHead(ctx context.Context, endpoint *url.URL, key string) (int64, error) {
	response, err := s.requestReaderAt(ctx, endpoint, http.MethodHead, key, nil, nil, nil, -1, "", hashBytes(nil))
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusMultipleChoices {
		return 0, s3ErrorFromResponse(response)
	}
	if response.ContentLength < 0 {
		return 0, fmt.Errorf("S3 HEAD response omitted object size")
	}
	return response.ContentLength, nil
}

func (s *s3Storage) objectSizeRangeGet(ctx context.Context, endpoint *url.URL, key string) (int64, error) {
	headers := make(http.Header)
	headers.Set("Range", "bytes=0-0")
	response, err := s.requestReaderAt(ctx, endpoint, http.MethodGet, key, nil, headers, nil, -1, "", hashBytes(nil))
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusMultipleChoices {
		if response.StatusCode == http.StatusRequestedRangeNotSatisfiable {
			if size, ok := parseS3UnsatisfiedContentRange(response.Header.Get("Content-Range")); ok {
				return size, nil
			}
		}
		return 0, s3ErrorFromResponse(response)
	}
	if response.StatusCode == http.StatusPartialContent {
		start, end, size, ok := parseS3ContentRange(response.Header.Get("Content-Range"))
		if !ok || start != 0 || end != 0 || size <= 0 {
			return 0, fmt.Errorf("S3 ranged GET returned an invalid Content-Range")
		}
		if _, err := io.CopyN(io.Discard, response.Body, 1); err != nil {
			return 0, fmt.Errorf("S3 ranged GET returned no object data: %w", err)
		}
		return size, nil
	}
	if response.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("S3 ranged GET returned unexpected status %s", response.Status)
	}
	if _, _, size, ok := parseS3ContentRange(response.Header.Get("Content-Range")); ok {
		return size, nil
	}
	if response.ContentLength < 0 {
		return 0, fmt.Errorf("S3 ranged GET response omitted object size")
	}
	return response.ContentLength, nil
}

func parseS3ContentRange(value string) (start, end, size int64, ok bool) {
	parts := strings.Fields(strings.TrimSpace(value))
	if len(parts) != 2 || strings.ToLower(parts[0]) != "bytes" {
		return 0, 0, 0, false
	}
	rangeAndSize := strings.SplitN(parts[1], "/", 2)
	if len(rangeAndSize) != 2 || rangeAndSize[0] == "*" || rangeAndSize[1] == "*" {
		return 0, 0, 0, false
	}
	bounds := strings.SplitN(rangeAndSize[0], "-", 2)
	if len(bounds) != 2 {
		return 0, 0, 0, false
	}
	start, err := strconv.ParseInt(bounds[0], 10, 64)
	if err != nil {
		return 0, 0, 0, false
	}
	end, err = strconv.ParseInt(bounds[1], 10, 64)
	if err != nil {
		return 0, 0, 0, false
	}
	size, err = strconv.ParseInt(rangeAndSize[1], 10, 64)
	if err != nil || start < 0 || end < start || size <= end {
		return 0, 0, 0, false
	}
	return start, end, size, true
}

func parseS3UnsatisfiedContentRange(value string) (int64, bool) {
	parts := strings.Fields(strings.TrimSpace(value))
	if len(parts) != 2 || strings.ToLower(parts[0]) != "bytes" {
		return 0, false
	}
	rangeAndSize := strings.SplitN(parts[1], "/", 2)
	if len(rangeAndSize) != 2 || rangeAndSize[0] != "*" {
		return 0, false
	}
	size, err := strconv.ParseInt(rangeAndSize[1], 10, 64)
	return size, err == nil && size >= 0
}

func (s *s3Storage) completeMultipartAndVerify(ctx context.Context, key, uploadID string, parts []s3MultipartPart, expectedBytes int64) error {
	if err := s.completeMultipart(ctx, key, uploadID, parts); err != nil {
		// A successful CompleteMultipartUpload response is authoritative and
		// does not require a follow-up HEAD. Only an ambiguous response (for
		// example a lost response, NoSuchUpload on a retry, or an S3 5xx) needs
		// object reconciliation. This is important for gateways that allow
		// multipart completion but reject HEAD.
		if !ambiguousMultipartCompletionError(ctx, err) {
			return err
		}
		actualBytes, reconcileErr := s.objectSize(ctx, key)
		if reconcileErr != nil {
			return fmt.Errorf("multipart completion response was ambiguous: %w; object reconciliation failed: %v", err, reconcileErr)
		}
		if actualBytes != expectedBytes {
			return fmt.Errorf("multipart completion response was ambiguous: %w; reconciled object size %d bytes does not match declared size %d bytes", err, actualBytes, expectedBytes)
		}
		return nil
	}
	return nil
}

func ambiguousMultipartCompletionError(ctx context.Context, err error) bool {
	if ctx.Err() != nil {
		return false
	}
	var responseErr *s3ResponseError
	if !errors.As(err, &responseErr) {
		return true
	}
	switch responseErr.status {
	case http.StatusNotFound, http.StatusRequestTimeout, http.StatusConflict, http.StatusTooManyRequests:
		return true
	default:
		return responseErr.status >= http.StatusInternalServerError
	}
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
