{{/* Expand the chart name. */}}
{{- define "justai.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Create a fully qualified app name. */}}
{{- define "justai.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/* Chart labels. */}}
{{- define "justai.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "justai.labels" -}}
helm.sh/chart: {{ include "justai.chart" . }}
{{ include "justai.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "justai.selectorLabels" -}}
app.kubernetes.io/name: {{ include "justai.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "justai.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "justai.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* Public origin used for same-origin API calls and callback defaults. */}}
{{- define "justai.publicOrigin" -}}
{{- $scheme := "http" -}}
{{- if .Values.ingress.tls }}{{- $scheme = "https" -}}{{- end -}}
{{- $host := "localhost" -}}
{{- if .Values.ingress.hosts }}
{{- $firstHost := index .Values.ingress.hosts 0 -}}
{{- if $firstHost.host }}{{- $host = $firstHost.host -}}{{- end -}}
{{- end -}}
{{- printf "%s://%s" $scheme $host -}}
{{- end }}

{{/* Resolve a credential Secret name. */}}
{{- define "justai.secretRefName" -}}
{{- $ref := index .root.Values.secrets.refs .ref -}}
{{- $generatedName := printf "%s-secrets" (include "justai.fullname" .root) -}}
{{- $ref.name | default .root.Values.secrets.existingSecret | default $generatedName -}}
{{- end }}

{{/* Resolve and validate a credential Secret key. */}}
{{- define "justai.secretRefKey" -}}
{{- $ref := index .root.Values.secrets.refs .ref -}}
{{- $key := $ref.key | default "" -}}
{{- if empty $key }}
{{- fail (printf "secrets.refs.%s.key must not be empty" .ref) }}
{{- end }}
{{- if not (regexMatch "^[A-Za-z0-9._-]+$" $key) }}
{{- fail (printf "secrets.refs.%s.key %q is invalid" .ref $key) }}
{{- end }}
{{- $key -}}
{{- end }}

{{- define "justai.validateSecretRefs" -}}
{{- $root := . -}}
{{- range $refName := list "databaseURL" "postgresqlPassword" "jwtSecret" "encryptionKey" "pyannoteHfToken" "pyannoteServiceToken" "backendHttpProxy" "backendHttpsProxy" "backendNoProxy" "pyannoteHttpProxy" "pyannoteHttpsProxy" "pyannoteNoProxy" "s3AccessKey" "s3SecretKey" -}}
{{- $_ := include "justai.secretRefKey" (dict "root" $root "ref" $refName) -}}
{{- end }}
{{- end }}

{{/* Backend egress settings are independent of optional Pyannote settings. */}}
{{- define "justai.backendProxyEnv" -}}
{{- $root := . -}}
{{- range $entry := list (dict "value" .Values.backend.proxy.http "ref" "backendHttpProxy" "env" "HTTP_PROXY") (dict "value" .Values.backend.proxy.https "ref" "backendHttpsProxy" "env" "HTTPS_PROXY") (dict "value" .Values.backend.proxy.noProxy "ref" "backendNoProxy" "env" "NO_PROXY") -}}
{{- $value := $entry.value -}}
{{- if kindIs "slice" $value }}{{- $value = join "," $value -}}{{- end -}}
{{- $data := index $root.Values.secrets.data $entry.ref -}}
{{- $ref := index $root.Values.secrets.refs $entry.ref -}}
{{- $managed := or $root.Values.secrets.create $root.Values.secrets.vault.enabled $root.Values.secrets.existingSecret -}}
{{- if and $data (not $managed) (not $ref.name) -}}
{{- fail (printf "secrets.data.%s requires secrets.create=true, secrets.vault.enabled=true, or secrets.refs.%s.name" $entry.ref $entry.ref) -}}
{{- end -}}
{{- if $value }}
- name: {{ $entry.env }}
  value: {{ $value | quote }}
{{- else if or $data $ref.name }}
- name: {{ $entry.env }}
  valueFrom:
    secretKeyRef:
      name: {{ include "justai.secretRefName" (dict "root" $root "ref" $entry.ref) | quote }}
      key: {{ include "justai.secretRefKey" (dict "root" $root "ref" $entry.ref) | quote }}
{{- end -}}
{{- end -}}
{{- end }}

{{- define "justai.validateManagedSecretRefs" -}}
{{- $root := . -}}
{{- $generatedName := printf "%s-secrets" (include "justai.fullname" $root) -}}
{{- $seen := dict -}}
{{- range $refName := list "databaseURL" "postgresqlPassword" "jwtSecret" "encryptionKey" "pyannoteHfToken" "pyannoteServiceToken" "backendHttpProxy" "backendHttpsProxy" "backendNoProxy" "pyannoteHttpProxy" "pyannoteHttpsProxy" "pyannoteNoProxy" "s3AccessKey" "s3SecretKey" -}}
{{- $name := include "justai.secretRefName" (dict "root" $root "ref" $refName) -}}
{{- $key := include "justai.secretRefKey" (dict "root" $root "ref" $refName) -}}
{{- if eq $name $generatedName }}
{{- if hasKey $seen $key }}
{{- fail (printf "secrets.refs.%s.key duplicates key %q already used by %s" $refName $key (index $seen $key)) }}
{{- end }}
{{- $_ := set $seen $key $refName -}}
{{- end }}
{{- end }}
{{- end }}

{{/* Build a database URL for the embedded pgvector service. */}}
{{- define "justai.databaseURL" -}}
{{- $password := .Values.secrets.data.postgresqlPassword | default "" -}}
{{- if .Values.postgresql.enabled -}}
{{- printf "postgres://%s:%s@%s:%d/%s?sslmode=disable" .Values.postgresql.auth.username $password (printf "%s-postgresql" (include "justai.fullname" .)) (.Values.postgresql.service.port | int) .Values.postgresql.auth.database -}}
{{- else -}}
{{- .Values.secrets.data.databaseURL | default "" -}}
{{- end -}}
{{- end }}
