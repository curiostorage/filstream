package main

import (
	"log"
	"net/http"
	"os"
	"strings"
)

func resolveDir(name string) string {
	if st, err := os.Stat(name); err == nil && st.IsDir() {
		return name
	}
	return name
}

func main() {
	staticRoot := resolveDir("docs")

	mux := http.NewServeMux()
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
