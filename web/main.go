package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func resolveDir(name string) string {
	candidates := []string{name, filepath.Join("web", name)}
	for _, c := range candidates {
		if st, err := os.Stat(c); err == nil && st.IsDir() {
			return c
		}
	}
	return name
}

func main() {
	staticRoot := resolveDir("statics")

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/debug-hls", handleDebugHls)
	if storeProxy, err := newStoreProxyHandler(storeBaseURLFromEnv()); err != nil {
		log.Printf("store proxy disabled: %v", err)
	} else {
		mux.Handle("/api/store/", storeProxy)
	}
	mux.Handle("/", http.FileServer(http.Dir(staticRoot)))

	addr := ":8080"
	if p := strings.TrimSpace(os.Getenv("PORT")); p != "" {
		if strings.HasPrefix(p, ":") {
			addr = p
		} else {
			addr = ":" + p
		}
	}

	log.Printf("serving static files from %q at http://localhost%s", staticRoot, addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
