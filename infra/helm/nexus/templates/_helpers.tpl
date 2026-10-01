{{/*
SPDX-License-Identifier: Apache-2.0
Common Helm template helpers for NEXUS.
*/}}

{{- define "nexus.fullname" -}}
{{- printf "%s" .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "nexus.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{ include "nexus.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "nexus.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* The Secret every component reads its keys from: an existing one, or the chart's own. */}}
{{- define "nexus.secretName" -}}
{{- .Values.existingSecret | default (printf "%s-secrets" (include "nexus.fullname" .)) -}}
{{- end -}}
