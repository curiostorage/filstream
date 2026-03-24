package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const maxDebugUploadBytes = 600 << 20 // 600 MiB when not trusted (see debugHlsTrustLargeBody)

// debugHlsTrustLargeBody is true when we skip the zip/multipart size cap (dev-only expectations).
// Host may be a machine name or LAN IP while the TCP client is still loopback; RemoteAddr covers that.
// Set FILSTREAM_DEBUG_UNLIMITED_BODY=1 to always allow large debug uploads (e.g. odd proxies).
func debugHlsTrustLargeBody(r *http.Request) bool {
	switch strings.TrimSpace(strings.ToLower(os.Getenv("FILSTREAM_DEBUG_UNLIMITED_BODY"))) {
	case "1", "true", "yes", "on":
		return true
	}
	if debugHlsHostLooksLocal(r.Host) {
		return true
	}
	return debugHlsRemoteAddrIsLoopback(r.RemoteAddr)
}

func debugHlsHostLooksLocal(hostport string) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	host = strings.TrimPrefix(strings.TrimSuffix(strings.TrimSpace(host), "]"), "[")
	if host == "" {
		return false
	}
	if strings.EqualFold(host, "localhost") {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

func debugHlsRemoteAddrIsLoopback(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	host = strings.TrimPrefix(strings.TrimSuffix(strings.TrimSpace(host), "]"), "[")
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

func safeDebugRelPath(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || strings.Contains(name, "..") {
		return "", errors.New("invalid path")
	}
	clean := filepath.Clean(name)
	if clean == "." || strings.HasPrefix(clean, "..") {
		return "", errors.New("invalid path")
	}
	return filepath.ToSlash(clean), nil
}

func handleDebugHls(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	ct := r.Header.Get("Content-Type")
	if ct == "application/zip" || strings.HasPrefix(ct, "application/zip;") {
		handleDebugHlsZip(w, r)
		return
	}

	multipartMax := int64(maxDebugUploadBytes)
	if debugHlsTrustLargeBody(r) {
		multipartMax = 1 << 40 // 1 TiB cap; trusted dev; avoids huge default memory issues
	}
	if err := r.ParseMultipartForm(multipartMax); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	runID := time.Now().Format("20060102-150405")
	baseDir := filepath.Join("debug-hls", runID)
	if err := os.MkdirAll(baseDir, 0o755); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	baseAbs, err := filepath.Abs(baseDir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if len(r.MultipartForm.File) == 0 {
		http.Error(w, "no files in multipart body", http.StatusBadRequest)
		return
	}

	for rel, headers := range r.MultipartForm.File {
		relNorm, err := safeDebugRelPath(rel)
		if err != nil {
			http.Error(w, "invalid field name: "+rel, http.StatusBadRequest)
			return
		}
		for _, fh := range headers {
			dest := filepath.Join(baseAbs, filepath.FromSlash(relNorm))
			destClean, err := filepath.Abs(dest)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if !strings.HasPrefix(destClean+string(os.PathSeparator), baseAbs+string(os.PathSeparator)) && destClean != baseAbs {
				http.Error(w, "path escapes output dir", http.StatusBadRequest)
				return
			}
			if err := os.MkdirAll(filepath.Dir(destClean), 0o755); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			src, err := fh.Open()
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			out, err := os.Create(destClean)
			if err != nil {
				src.Close()
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			_, copyErr := io.Copy(out, src)
			closeOutErr := out.Close()
			src.Close()
			if copyErr != nil {
				http.Error(w, copyErr.Error(), http.StatusInternalServerError)
				return
			}
			if closeOutErr != nil {
				http.Error(w, closeOutErr.Error(), http.StatusInternalServerError)
				return
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"savedTo": baseDir,
	})
	log.Printf("debug-hls: wrote upload to %q", baseDir)
}

// handleDebugHlsZip accepts one application/zip body (avoids Go's default 1000 multipart part limit).
func handleDebugHlsZip(w http.ResponseWriter, r *http.Request) {
	runID := time.Now().Format("20060102-150405")
	baseDir := filepath.Join("debug-hls", runID)
	if err := os.MkdirAll(baseDir, 0o755); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	baseAbs, err := filepath.Abs(baseDir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	var body []byte
	var readErr error
	if debugHlsTrustLargeBody(r) {
		body, readErr = io.ReadAll(r.Body)
	} else {
		body, readErr = io.ReadAll(io.LimitReader(r.Body, maxDebugUploadBytes+1))
		if int64(len(body)) > maxDebugUploadBytes {
			log.Printf(
				"debug-hls zip: body over %d MiB (set FILSTREAM_DEBUG_UNLIMITED_BODY=1 or use loopback client; host=%q remote=%q)",
				maxDebugUploadBytes>>20, r.Host, r.RemoteAddr,
			)
			http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
			return
		}
	}
	if readErr != nil {
		http.Error(w, readErr.Error(), http.StatusBadRequest)
		return
	}

	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		http.Error(w, "invalid zip: "+err.Error(), http.StatusBadRequest)
		return
	}

	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		zname := strings.TrimPrefix(strings.ReplaceAll(strings.TrimSpace(f.Name), "\\", "/"), "/")
		relNorm, err := safeDebugRelPath(zname)
		if err != nil {
			http.Error(w, "invalid zip entry: "+f.Name, http.StatusBadRequest)
			return
		}
		dest := filepath.Join(baseAbs, filepath.FromSlash(relNorm))
		destClean, err := filepath.Abs(dest)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if !strings.HasPrefix(destClean+string(os.PathSeparator), baseAbs+string(os.PathSeparator)) && destClean != baseAbs {
			http.Error(w, "path escapes output dir", http.StatusBadRequest)
			return
		}
		if err := os.MkdirAll(filepath.Dir(destClean), 0o755); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		rc, err := f.Open()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out, err := os.Create(destClean)
		if err != nil {
			rc.Close()
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_, copyErr := io.Copy(out, rc)
		closeOutErr := out.Close()
		rc.Close()
		if copyErr != nil {
			http.Error(w, copyErr.Error(), http.StatusInternalServerError)
			return
		}
		if closeOutErr != nil {
			http.Error(w, closeOutErr.Error(), http.StatusInternalServerError)
			return
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"savedTo": baseDir,
	})
	log.Printf("debug-hls: extracted zip to %q", baseDir)
}
