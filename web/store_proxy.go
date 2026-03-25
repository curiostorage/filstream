package main

import (
	"errors"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
)

// storeBaseURLFromEnv resolves the store service base URL used by the reverse proxy.
func storeBaseURLFromEnv() string {
	raw := strings.TrimSpace(os.Getenv("STORE_BASE_URL"))
	if raw != "" {
		return raw
	}
	return "http://127.0.0.1:8090"
}

// newStoreProxyHandler builds an HTTP handler that proxies `/api/store/*` requests.
func newStoreProxyHandler(baseURL string) (http.Handler, error) {
	baseURL = strings.TrimSpace(baseURL)
	if baseURL == "" {
		return nil, errors.New("empty store base URL")
	}
	target, err := url.Parse(baseURL)
	if err != nil {
		return nil, err
	}
	if target.Scheme == "" || target.Host == "" {
		return nil, errors.New("STORE_BASE_URL must include scheme and host")
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Preserve original path/query under the same `/api/store/*` route.
		r.Host = target.Host
		proxy.ServeHTTP(w, r)
	}), nil
}
